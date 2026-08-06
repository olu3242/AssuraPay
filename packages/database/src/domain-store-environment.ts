import path from 'node:path';

/**
 * Where the JSON domain store may run, and where its file actually lives.
 *
 * `FileAssuraStore` is still the production domain store for Engines 06-60 —
 * `persistence.domain-store-durability` has not been implemented. That is a known gap. What is
 * *not* acceptable while it stands is the two behaviours this module removes, both found by
 * inspecting the live composition root rather than by reading the plan.
 *
 * **The data file's location depended on the working directory.** It was
 * `path.resolve(process.cwd(), 'apps/web/data/assurapay.json')`, so a process started from the
 * repository root and one started from `apps/web` read and wrote different files:
 *
 *     /repo            -> /repo/apps/web/data/assurapay.json
 *     /repo/apps/web   -> /repo/apps/web/apps/web/data/assurapay.json
 *
 * Not hypothetical — the second file existed, holding thirteen records the first did not have.
 * A store whose identity depends on how the process was launched silently forks its own state,
 * and neither copy is discoverably the real one.
 *
 * **Demo data was fabricated in any environment.** The composition root seeded a `tenant-demo`
 * workspace and a full contract-to-payment scenario whenever `contracts` was empty, with no
 * environment condition at all. An empty production database therefore acquired invented
 * tenants, milestones and payment-eligibility records that look exactly like real ones.
 *
 * The trust side already answers this shape of question: a durable environment refuses to start
 * rather than serve from volatile storage. Refusing is safer than serving fabricated data, and
 * it is the same reasoning, so it is the same behaviour here.
 */

/** Deployment classes that must not use file-backed domain persistence. */
export const DURABLE_DOMAIN_DEPLOYMENT_CLASSES: readonly string[] = Object.freeze([
  'production',
  'staging',
  'release-candidate',
  'hosted-pilot',
  'persistent-preview',
]);

/** The variable a deployment sets to declare what it is. */
export const DEPLOYMENT_VARIABLE = 'ASSURAPAY_DEPLOYMENT';

/** Overrides the domain store's file location explicitly, for a deployment that has one. */
export const DOMAIN_STORE_FILE_VARIABLE = 'ASSURAPAY_DOMAIN_STORE_FILE';

export class DomainStoreNotDurableError extends Error {
  readonly code = 'DOMAIN_STORE_NOT_DURABLE';
  readonly deployment: string;

  constructor(deployment: string) {
    super(
      `DOMAIN_STORE_NOT_DURABLE: ${deployment} is a durable deployment, and the only domain ` +
        'store for Engines 06-60 is file-backed JSON. It is not durable, is not covered by ' +
        'row-level security, and its composition root fabricates demo tenants into an empty ' +
        'dataset. Refusing to start rather than serve invented data as real. ' +
        'persistence.domain-store-durability replaces it; until then run this deployment as ' +
        'development or test.',
    );
    this.name = 'DomainStoreNotDurableError';
    this.deployment = deployment;
  }
}

/** A bag of environment variables. Deliberately not `NodeJS.ProcessEnv`, which requires keys a
 * test fixture has no reason to supply. */
export type EnvironmentLike = Record<string, string | undefined>;

export function isDurableDomainDeployment(environment: EnvironmentLike = process.env): boolean {
  const deployment = environment[DEPLOYMENT_VARIABLE]?.trim().toLowerCase();
  if (!deployment) return false;
  return DURABLE_DOMAIN_DEPLOYMENT_CLASSES.includes(deployment);
}

/**
 * Refuses a file-backed domain store in a durable deployment.
 *
 * Throws rather than returning a flag, because every caller of a "may I?" predicate is one
 * forgotten branch away from proceeding anyway. `NODE_ENV` is deliberately not consulted: it is
 * `production` for any optimized build, including a local one, so gating on it would refuse
 * development and permit a real deployment that never set it.
 */
export function assertDomainStoreAllowed(environment: EnvironmentLike = process.env): void {
  if (!isDurableDomainDeployment(environment)) return;
  throw new DomainStoreNotDurableError(
    environment[DEPLOYMENT_VARIABLE]!.trim().toLowerCase(),
  );
}

/** Whether demo data may be fabricated here. Never in a durable deployment. */
export function mayFabricateDemoData(environment: EnvironmentLike = process.env): boolean {
  return !isDurableDomainDeployment(environment);
}

/**
 * The domain store's file, resolved without reference to the working directory.
 *
 * An explicit `ASSURAPAY_DOMAIN_STORE_FILE` wins. Otherwise the path is derived from this
 * module's own location by walking up to the workspace root, so it is the same file whichever
 * directory the process was started from. `packageRoot` is injected only so the resolution
 * itself can be tested without a real workspace layout.
 */
export function resolveDomainStoreFile(
  environment: EnvironmentLike = process.env,
  moduleDirectory: string = defaultModuleDirectory(),
): string {
  const explicit = environment[DOMAIN_STORE_FILE_VARIABLE]?.trim();
  if (explicit) return path.resolve(explicit);
  // packages/database/src -> packages/database -> packages -> <workspace root>
  const workspaceRoot = path.resolve(moduleDirectory, '..', '..', '..');
  return path.join(workspaceRoot, 'apps', 'web', 'data', 'assurapay.json');
}

function defaultModuleDirectory(): string {
  // `__dirname` under the CommonJS-interop build the repository compiles to, and the directory
  // of this module either way. Node's type stripping keeps this working without a bundler.
  return __dirname;
}
