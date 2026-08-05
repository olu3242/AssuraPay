/**
 * Server-only persistence configuration.
 *
 * Read once, validated eagerly, and never re-read per request. Two properties matter
 * more than the rest:
 *
 * **A durable environment cannot run on volatile storage.** Not "prefers not to" — the
 * configuration is rejected. The shape this replaces was
 * `databaseUrl ? new PostgresTrustStore(...) : new InMemoryTrustStore()`, which turns a
 * missing environment variable into a silent switch to a store that loses every grant,
 * membership and audit record when the process exits. The application keeps answering,
 * authorization keeps deciding, and nothing reports that history is being discarded.
 *
 * **Adapter selection is never caller-controlled.** No request header, body, tenant
 * record or `NEXT_PUBLIC_*` variable can influence it. A client-visible variable is a
 * variable a client can be told to change.
 */

export type DeploymentClass =
  | 'production'
  | 'staging'
  | 'release-candidate'
  | 'hosted-pilot'
  | 'persistent-preview'
  | 'development'
  | 'test';

/**
 * Environments whose state outlives the process, and therefore require PostgreSQL.
 *
 * A persistent preview is on the list deliberately: it has real users looking at real
 * data, and "it is only a preview" is how volatile storage reaches people.
 */
export const DURABLE_DEPLOYMENT_CLASSES: readonly DeploymentClass[] = Object.freeze([
  'production',
  'staging',
  'release-candidate',
  'hosted-pilot',
  'persistent-preview',
]);

export type PersistenceAdapter = 'postgres' | 'memory';

/** Variables that must never select persistence, because a client can read them. */
export const FORBIDDEN_CLIENT_VARIABLES: readonly string[] = Object.freeze([
  'NEXT_PUBLIC_DATABASE_URL',
  'NEXT_PUBLIC_POSTGRES_URL',
  'NEXT_PUBLIC_PERSISTENCE_MODE',
  'NEXT_PUBLIC_PERSISTENCE_ADAPTER',
]);

export type PersistenceRuntimeConfig = {
  deployment: DeploymentClass;
  adapter: PersistenceAdapter;
  /** Present whenever `adapter` is `postgres`. Never logged. */
  databaseUrl?: string;
  ssl: 'disable' | 'require' | 'verify-full';
  poolMax: number;
  connectTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  statementTimeoutSeconds: number;
  startupTimeoutSeconds: number;
  shutdownGraceSeconds: number;
  /**
   * Whether startup verifies that the migration ledger matches the migration set.
   *
   * On by default. Turning it off is a deliberate operator decision for a host that
   * deploys ahead of its migrations, and it is recorded in the runtime's evidence so the
   * choice is visible rather than assumed.
   */
  verifyMigrations: boolean;
  /** Whether startup verifies the required tables exist. On by default. */
  verifySchema: boolean;
  applicationName: string;
};

export type PersistenceConfigErrorCode =
  | 'PERSISTENCE_CONFIG_DEPLOYMENT_UNKNOWN'
  | 'PERSISTENCE_CONFIG_ADAPTER_UNKNOWN'
  | 'PERSISTENCE_CONFIG_DURABLE_REQUIRES_POSTGRES'
  | 'PERSISTENCE_CONFIG_DATABASE_URL_REQUIRED'
  | 'PERSISTENCE_CONFIG_DATABASE_URL_INVALID'
  | 'PERSISTENCE_CONFIG_SSL_REQUIRED'
  | 'PERSISTENCE_CONFIG_BOUND_INVALID'
  | 'PERSISTENCE_CONFIG_CLIENT_VARIABLE_FORBIDDEN';

export class PersistenceConfigError extends Error {
  readonly code: PersistenceConfigErrorCode;

  constructor(code: PersistenceConfigErrorCode, detail: string) {
    // `detail` is written by this module only and never interpolates a configured
    // value. A rejected connection string is the value most likely to carry a
    // password, and error text reaches logs.
    super(`${code}: ${detail}`);
    this.name = 'PersistenceConfigError';
    this.code = code;
  }
}

const DEPLOYMENT_CLASSES: readonly DeploymentClass[] = Object.freeze([
  'production',
  'staging',
  'release-candidate',
  'hosted-pilot',
  'persistent-preview',
  'development',
  'test',
]);

export function isDurableDeployment(deployment: DeploymentClass): boolean {
  return DURABLE_DEPLOYMENT_CLASSES.includes(deployment);
}

type Environment = Record<string, string | undefined>;

function integer(
  environment: Environment,
  name: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max)
    throw new PersistenceConfigError(
      'PERSISTENCE_CONFIG_BOUND_INVALID',
      `${name} must be an integer between ${bounds.min} and ${bounds.max}`,
    );
  return value;
}

function boolean(environment: Environment, name: string, fallback: boolean): boolean {
  const raw = environment[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  throw new PersistenceConfigError(
    'PERSISTENCE_CONFIG_BOUND_INVALID',
    `${name} must be a boolean`,
  );
}

/**
 * Derives the deployment class.
 *
 * `ASSURAPAY_DEPLOYMENT` is authoritative when set. Otherwise it is inferred from
 * `NODE_ENV`, and the inference is deliberately pessimistic: `NODE_ENV=production`
 * means a durable environment, so a host that forgets to declare itself gets the strict
 * rules rather than the permissive ones.
 */
function resolveDeployment(environment: Environment): DeploymentClass {
  const declared = environment.ASSURAPAY_DEPLOYMENT?.trim().toLowerCase();
  if (declared) {
    const match = DEPLOYMENT_CLASSES.find((candidate) => candidate === declared);
    if (!match)
      throw new PersistenceConfigError(
        'PERSISTENCE_CONFIG_DEPLOYMENT_UNKNOWN',
        `ASSURAPAY_DEPLOYMENT must be one of ${DEPLOYMENT_CLASSES.join(', ')}`,
      );
    return match;
  }

  if (environment.VITEST) return 'test';
  const nodeEnv = environment.NODE_ENV?.trim().toLowerCase();
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'test') return 'test';
  return 'development';
}

/**
 * Reads and validates the configuration, or throws.
 *
 * Throwing is the point. A configuration this function accepts is one the runtime can
 * honour; anything else must stop the host from starting rather than degrade it.
 */
export function loadPersistenceConfig(
  environment: Environment = process.env,
): PersistenceRuntimeConfig {
  for (const name of FORBIDDEN_CLIENT_VARIABLES)
    if (environment[name] !== undefined)
      throw new PersistenceConfigError(
        'PERSISTENCE_CONFIG_CLIENT_VARIABLE_FORBIDDEN',
        `${name} is set. A client-visible variable must not influence persistence; use the server-only equivalent.`,
      );

  const deployment = resolveDeployment(environment);
  const durable = isDurableDeployment(deployment);

  const declaredAdapter = environment.ASSURAPAY_PERSISTENCE_ADAPTER?.trim().toLowerCase();
  if (declaredAdapter !== undefined && !['postgres', 'memory', ''].includes(declaredAdapter))
    throw new PersistenceConfigError(
      'PERSISTENCE_CONFIG_ADAPTER_UNKNOWN',
      'ASSURAPAY_PERSISTENCE_ADAPTER must be postgres or memory',
    );

  // Durable environments do not get a choice, and an explicit `memory` there is an
  // error rather than a preference honoured with a warning. Elsewhere the default
  // remains memory, so a developer with no database still has a working application.
  const adapter: PersistenceAdapter = durable
    ? 'postgres'
    : declaredAdapter === 'postgres'
      ? 'postgres'
      : 'memory';

  if (durable && declaredAdapter === 'memory')
    throw new PersistenceConfigError(
      'PERSISTENCE_CONFIG_DURABLE_REQUIRES_POSTGRES',
      `${deployment} requires PostgreSQL. An in-memory store loses every grant, membership and audit record when the process exits, while the application keeps answering as though it had not.`,
    );

  const databaseUrl = environment.ASSURAPAY_DATABASE_URL?.trim() || environment.DATABASE_URL?.trim();

  if (adapter === 'postgres') {
    if (!databaseUrl)
      throw new PersistenceConfigError(
        'PERSISTENCE_CONFIG_DATABASE_URL_REQUIRED',
        durable
          ? `${deployment} requires a database URL. There is no implicit localhost fallback: a production host that quietly connected to a local database would report healthy while serving nothing.`
          : 'the postgres adapter requires ASSURAPAY_DATABASE_URL',
      );

    let parsed: URL;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new PersistenceConfigError(
        'PERSISTENCE_CONFIG_DATABASE_URL_INVALID',
        'the database URL is not a valid URL',
      );
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
      throw new PersistenceConfigError(
        'PERSISTENCE_CONFIG_DATABASE_URL_INVALID',
        'the database URL must use the postgres scheme',
      );
    if (!parsed.hostname)
      throw new PersistenceConfigError(
        'PERSISTENCE_CONFIG_DATABASE_URL_INVALID',
        'the database URL has no host',
      );
  }

  const declaredSsl = environment.ASSURAPAY_DATABASE_SSL?.trim().toLowerCase();
  if (declaredSsl !== undefined && !['disable', 'require', 'verify-full', ''].includes(declaredSsl))
    throw new PersistenceConfigError(
      'PERSISTENCE_CONFIG_BOUND_INVALID',
      'ASSURAPAY_DATABASE_SSL must be disable, require or verify-full',
    );

  // Explicit in durable environments, never inferred. Defaulting to encrypted would be
  // a silent guess about the network; defaulting to plaintext would be worse. The
  // operator states it.
  if (durable && (declaredSsl === undefined || declaredSsl === ''))
    throw new PersistenceConfigError(
      'PERSISTENCE_CONFIG_SSL_REQUIRED',
      `${deployment} must state ASSURAPAY_DATABASE_SSL explicitly rather than inheriting a default`,
    );
  if (durable && declaredSsl === 'disable')
    throw new PersistenceConfigError(
      'PERSISTENCE_CONFIG_SSL_REQUIRED',
      `${deployment} must not disable TLS to the database`,
    );

  const ssl = (declaredSsl || 'disable') as PersistenceRuntimeConfig['ssl'];

  const config: PersistenceRuntimeConfig = {
    deployment,
    adapter,
    ssl,
    poolMax: integer(environment, 'ASSURAPAY_DATABASE_POOL_MAX', 10, { min: 1, max: 200 }),
    connectTimeoutSeconds: integer(environment, 'ASSURAPAY_DATABASE_CONNECT_TIMEOUT_SECONDS', 10, {
      min: 1,
      max: 120,
    }),
    idleTimeoutSeconds: integer(environment, 'ASSURAPAY_DATABASE_IDLE_TIMEOUT_SECONDS', 30, {
      min: 1,
      max: 3600,
    }),
    statementTimeoutSeconds: integer(
      environment,
      'ASSURAPAY_DATABASE_STATEMENT_TIMEOUT_SECONDS',
      30,
      { min: 1, max: 600 },
    ),
    startupTimeoutSeconds: integer(environment, 'ASSURAPAY_STARTUP_TIMEOUT_SECONDS', 30, {
      min: 1,
      max: 300,
    }),
    shutdownGraceSeconds: integer(environment, 'ASSURAPAY_SHUTDOWN_GRACE_SECONDS', 15, {
      min: 0,
      max: 300,
    }),
    verifyMigrations: boolean(environment, 'ASSURAPAY_VERIFY_MIGRATIONS', true),
    verifySchema: boolean(environment, 'ASSURAPAY_VERIFY_SCHEMA', true),
    applicationName: environment.ASSURAPAY_APPLICATION_NAME?.trim() || 'assurapay-web',
  };

  if (adapter === 'postgres') config.databaseUrl = databaseUrl;
  return config;
}

/**
 * The configuration with every secret removed, for logs and health responses.
 *
 * The database URL is not included in any form — not host, not user. A readiness probe
 * is often public, and an internal hostname is a fact about the deployment that a probe
 * has no reason to publish.
 */
export function describePersistenceConfig(
  config: PersistenceRuntimeConfig,
): Record<string, unknown> {
  return {
    deployment: config.deployment,
    adapter: config.adapter,
    ssl: config.ssl,
    poolMax: config.poolMax,
    statementTimeoutSeconds: config.statementTimeoutSeconds,
    verifyMigrations: config.verifyMigrations,
    verifySchema: config.verifySchema,
    applicationName: config.applicationName,
  };
}
