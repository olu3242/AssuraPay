import { describe, expect, it } from 'vitest';
import {
  DURABLE_DEPLOYMENT_CLASSES,
  FORBIDDEN_CLIENT_VARIABLES,
  PersistenceConfigError,
  describePersistenceConfig,
  isDurableDeployment,
  loadPersistenceConfig,
} from './config';

/**
 * Configuration is where volatile storage in production is prevented, so these are the
 * tests that matter most in this package.
 *
 * The shape being prevented is one line long and reads as sensible:
 *
 *     const store = databaseUrl ? new PostgresTrustStore(...) : new InMemoryTrustStore();
 *
 * It turns a missing environment variable into a silent switch to a store that discards
 * every grant, membership and audit record when the process exits, while the application
 * keeps answering and authorization keeps deciding.
 */

const POSTGRES = 'postgres://user:secret@db.internal:5432/assurapay';

function durableEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    ASSURAPAY_DEPLOYMENT: 'production',
    ASSURAPAY_DATABASE_URL: POSTGRES,
    ASSURAPAY_DATABASE_SSL: 'require',
    ...overrides,
  };
}

describe('durable environments require PostgreSQL', () => {
  it('resolves the postgres adapter for every durable deployment class', () => {
    for (const deployment of DURABLE_DEPLOYMENT_CLASSES) {
      const config = loadPersistenceConfig(durableEnvironment({ ASSURAPAY_DEPLOYMENT: deployment }));
      expect(config.adapter, deployment).toBe('postgres');
      expect(isDurableDeployment(deployment)).toBe(true);
    }
  });

  it('refuses an explicitly requested memory adapter rather than warning about it', () => {
    // Honoured-with-a-warning is how volatile storage reaches production: nobody reads
    // the warning, and the application looks healthy.
    for (const deployment of DURABLE_DEPLOYMENT_CLASSES) {
      const error = (() => {
        try {
          loadPersistenceConfig(
            durableEnvironment({
              ASSURAPAY_DEPLOYMENT: deployment,
              ASSURAPAY_PERSISTENCE_ADAPTER: 'memory',
            }),
          );
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();

      expect(error, deployment).toBeInstanceOf(PersistenceConfigError);
      expect((error as PersistenceConfigError).code).toBe(
        'PERSISTENCE_CONFIG_DURABLE_REQUIRES_POSTGRES',
      );
    }
  });

  it('refuses a durable deployment with no database URL, with no localhost fallback', () => {
    // A production host that quietly connected to a local database would report healthy
    // while serving nothing.
    expect(() =>
      loadPersistenceConfig({ ASSURAPAY_DEPLOYMENT: 'production', ASSURAPAY_DATABASE_SSL: 'require' }),
    ).toThrow('PERSISTENCE_CONFIG_DATABASE_URL_REQUIRED');
  });

  it('treats NODE_ENV=production as durable even when the deployment is undeclared', () => {
    // Pessimistic on purpose: a host that forgets to declare itself gets the strict rules
    // rather than the permissive ones. It refuses on the database URL first, then on TLS —
    // the order does not matter, only that a bare NODE_ENV=production cannot boot on
    // volatile storage.
    expect(() => loadPersistenceConfig({ NODE_ENV: 'production' })).toThrow(
      'PERSISTENCE_CONFIG_DATABASE_URL_REQUIRED',
    );
    expect(() =>
      loadPersistenceConfig({ NODE_ENV: 'production', ASSURAPAY_DATABASE_URL: POSTGRES }),
    ).toThrow('PERSISTENCE_CONFIG_SSL_REQUIRED');
    expect(() =>
      loadPersistenceConfig({ NODE_ENV: 'production', ASSURAPAY_PERSISTENCE_ADAPTER: 'memory' }),
    ).toThrow('PERSISTENCE_CONFIG_DURABLE_REQUIRES_POSTGRES');
  });

  it('requires TLS to be stated, and refuses it being switched off', () => {
    expect(() =>
      loadPersistenceConfig({
        ASSURAPAY_DEPLOYMENT: 'production',
        ASSURAPAY_DATABASE_URL: POSTGRES,
      }),
    ).toThrow('PERSISTENCE_CONFIG_SSL_REQUIRED');

    expect(() =>
      loadPersistenceConfig(durableEnvironment({ ASSURAPAY_DATABASE_SSL: 'disable' })),
    ).toThrow('PERSISTENCE_CONFIG_SSL_REQUIRED');
  });

  it('accepts a fully specified durable configuration', () => {
    const config = loadPersistenceConfig(durableEnvironment());
    expect(config).toMatchObject({
      deployment: 'production',
      adapter: 'postgres',
      ssl: 'require',
      verifyMigrations: true,
      verifySchema: true,
    });
    expect(config.databaseUrl).toBe(POSTGRES);
  });
});

describe('non-durable environments still work without a database', () => {
  it('defaults to memory in development, so a developer with no database can run the app', () => {
    const config = loadPersistenceConfig({ ASSURAPAY_DEPLOYMENT: 'development' });
    expect(config.adapter).toBe('memory');
    expect(config.databaseUrl).toBeUndefined();
  });

  it('uses postgres in development when asked, and then insists on a URL', () => {
    expect(() =>
      loadPersistenceConfig({
        ASSURAPAY_DEPLOYMENT: 'development',
        ASSURAPAY_PERSISTENCE_ADAPTER: 'postgres',
      }),
    ).toThrow('PERSISTENCE_CONFIG_DATABASE_URL_REQUIRED');

    const config = loadPersistenceConfig({
      ASSURAPAY_DEPLOYMENT: 'development',
      ASSURAPAY_PERSISTENCE_ADAPTER: 'postgres',
      ASSURAPAY_DATABASE_URL: POSTGRES,
    });
    expect(config.adapter).toBe('postgres');
  });

  it('recognizes a test run without being told', () => {
    expect(loadPersistenceConfig({ VITEST: 'true' }).deployment).toBe('test');
  });
});

describe('persistence cannot be selected by anything a client can reach', () => {
  it('refuses every client-visible variable that could influence it', () => {
    // A NEXT_PUBLIC_* variable is compiled into the browser bundle. A variable a client
    // can read is a variable a client can be told to change.
    for (const name of FORBIDDEN_CLIENT_VARIABLES) {
      const error = (() => {
        try {
          loadPersistenceConfig(durableEnvironment({ [name]: 'postgres://elsewhere/db' }));
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error, name).toBeInstanceOf(PersistenceConfigError);
      expect((error as PersistenceConfigError).code).toBe(
        'PERSISTENCE_CONFIG_CLIENT_VARIABLE_FORBIDDEN',
      );
    }
  });

  it('names NEXT_PUBLIC_DATABASE_URL specifically, the variable most likely to be tried', () => {
    expect(FORBIDDEN_CLIENT_VARIABLES).toContain('NEXT_PUBLIC_DATABASE_URL');
    expect(FORBIDDEN_CLIENT_VARIABLES).toContain('NEXT_PUBLIC_PERSISTENCE_MODE');
  });
});

describe('bounds and identifiers are validated, not coerced', () => {
  it('refuses a non-integer or out-of-range bound', () => {
    for (const [name, value] of [
      ['ASSURAPAY_DATABASE_POOL_MAX', 'lots'],
      ['ASSURAPAY_DATABASE_POOL_MAX', '0'],
      ['ASSURAPAY_DATABASE_POOL_MAX', '1.5'],
      ['ASSURAPAY_DATABASE_STATEMENT_TIMEOUT_SECONDS', '-1'],
      ['ASSURAPAY_STARTUP_TIMEOUT_SECONDS', '99999'],
    ] as const)
      expect(() => loadPersistenceConfig(durableEnvironment({ [name]: value })), `${name}=${value}`).toThrow(
        'PERSISTENCE_CONFIG_BOUND_INVALID',
      );
  });

  it('refuses an unknown deployment class rather than guessing', () => {
    expect(() => loadPersistenceConfig({ ASSURAPAY_DEPLOYMENT: 'prodction' })).toThrow(
      'PERSISTENCE_CONFIG_DEPLOYMENT_UNKNOWN',
    );
  });

  it('refuses a URL that is not a postgres URL', () => {
    for (const url of ['not-a-url', 'mysql://host/db', 'postgres:///no-host'])
      expect(() =>
        loadPersistenceConfig(durableEnvironment({ ASSURAPAY_DATABASE_URL: url })),
      ).toThrow('PERSISTENCE_CONFIG_DATABASE_URL_INVALID');
  });
});

describe('errors and descriptions carry no secrets', () => {
  it('never quotes the database URL in a rejection', () => {
    // The rejected connection string is the value most likely to carry a password, and
    // error text reaches logs.
    const error = (() => {
      try {
        loadPersistenceConfig(
          durableEnvironment({ ASSURAPAY_DATABASE_URL: 'postgres://user:hunter2@host/db?x' }),
        );
        return undefined;
      } catch (caught) {
        return caught;
      }
    })();
    // This particular URL is valid, so nothing is thrown — the assertion below covers the
    // invalid case, which is where a naive implementation would echo the input.
    expect(error).toBeUndefined();

    const invalid = (() => {
      try {
        loadPersistenceConfig(durableEnvironment({ ASSURAPAY_DATABASE_URL: 'mysql://user:hunter2@host/db' }));
        return undefined;
      } catch (caught) {
        return caught as Error;
      }
    })();
    expect(String(invalid)).not.toContain('hunter2');
    expect(String(invalid)).not.toContain('host');
  });

  it('describes the configuration without the URL in any form', () => {
    const described = describePersistenceConfig(loadPersistenceConfig(durableEnvironment()));
    const serialised = JSON.stringify(described);

    expect(serialised).not.toContain('secret');
    expect(serialised).not.toContain('db.internal');
    expect(serialised).not.toContain('postgres://');
    // What it does report: enough to tell two deployments apart in a log.
    expect(described).toMatchObject({ deployment: 'production', adapter: 'postgres', ssl: 'require' });
  });
});
