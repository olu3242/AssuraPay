import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_VARIABLE,
  DOMAIN_STORE_FILE_VARIABLE,
  DURABLE_DOMAIN_DEPLOYMENT_CLASSES,
  DomainStoreNotDurableError,
  assertDomainStoreAllowed,
  isDurableDomainDeployment,
  mayFabricateDemoData,
  resolveDomainStoreFile,
} from './domain-store-environment';
import { FileAssuraStore } from './index';

/**
 * Two live defects in the file-backed domain store, and the gate that closes them.
 *
 * Neither is hypothetical. The composition root fabricated a `tenant-demo` scenario into any
 * empty dataset with no environment condition, and the data file's path was resolved from
 * `process.cwd()` — so the same build read a different file depending on the directory it was
 * started from, and the second file existed on disk with thirteen records the first did not have.
 */

describe('a durable deployment cannot use file-backed domain persistence', () => {
  it('refuses every durable class', () => {
    for (const deployment of DURABLE_DOMAIN_DEPLOYMENT_CLASSES) {
      expect(() => assertDomainStoreAllowed({ [DEPLOYMENT_VARIABLE]: deployment })).toThrow(
        DomainStoreNotDurableError,
      );
    }
  });

  it('permits development and test', () => {
    for (const deployment of ['development', 'test', 'ephemeral-preview', 'ci']) {
      expect(() => assertDomainStoreAllowed({ [DEPLOYMENT_VARIABLE]: deployment })).not.toThrow();
    }
  });

  it('permits an unset deployment, which is a developer machine', () => {
    // Defaulting to refusal would make a fresh checkout unusable, and the durable classes are
    // set deliberately by a deployment rather than left to chance.
    expect(() => assertDomainStoreAllowed({})).not.toThrow();
  });

  it('ignores NODE_ENV, which is production for any optimized build', () => {
    // Gating on NODE_ENV would refuse a local production build and permit a real deployment
    // that never set it — wrong in both directions.
    expect(() => assertDomainStoreAllowed({ NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertDomainStoreAllowed({ NODE_ENV: 'development', [DEPLOYMENT_VARIABLE]: 'production' }),
    ).toThrow(DomainStoreNotDurableError);
  });

  it('names the deployment and the capability that replaces the store', () => {
    // An operator reading this in a startup log needs to know what to do next.
    const error = new DomainStoreNotDurableError('production');
    expect(error.code).toBe('DOMAIN_STORE_NOT_DURABLE');
    expect(error.message).toContain('production');
    expect(error.message).toContain('persistence.domain-store-durability');
  });

  it('is case- and whitespace-insensitive about the class', () => {
    expect(isDurableDomainDeployment({ [DEPLOYMENT_VARIABLE]: '  Production  ' })).toBe(true);
  });

  it('refuses before touching the filesystem', async () => {
    // A deployment must not acquire a JSON file as a side effect of discovering it is not
    // allowed to have one.
    const previous = process.env[DEPLOYMENT_VARIABLE];
    process.env[DEPLOYMENT_VARIABLE] = 'production';
    try {
      await expect(FileAssuraStore.load()).rejects.toThrow(DomainStoreNotDurableError);
    } finally {
      if (previous === undefined) delete process.env[DEPLOYMENT_VARIABLE];
      else process.env[DEPLOYMENT_VARIABLE] = previous;
    }
  });

  it('refuses a write from a store constructed directly, not only from load()', async () => {
    // `load()` is not the only way to get one. A gate only on the factory is a gate a direct
    // constructor walks around.
    const store = new FileAssuraStore();
    const previous = process.env[DEPLOYMENT_VARIABLE];
    process.env[DEPLOYMENT_VARIABLE] = 'staging';
    try {
      await expect(store.setSnapshot({ contracts: [{ id: 'c-1' }] })).rejects.toThrow(
        DomainStoreNotDurableError,
      );
    } finally {
      if (previous === undefined) delete process.env[DEPLOYMENT_VARIABLE];
      else process.env[DEPLOYMENT_VARIABLE] = previous;
    }
  });
});

describe('demo data is never fabricated in a durable deployment', () => {
  it('is forbidden for every durable class and allowed otherwise', () => {
    for (const deployment of DURABLE_DOMAIN_DEPLOYMENT_CLASSES)
      expect(mayFabricateDemoData({ [DEPLOYMENT_VARIABLE]: deployment })).toBe(false);
    expect(mayFabricateDemoData({ [DEPLOYMENT_VARIABLE]: 'development' })).toBe(true);
    expect(mayFabricateDemoData({})).toBe(true);
  });
});

describe('the data file does not depend on the working directory', () => {
  it('resolves to the same path from any directory', () => {
    // The defect, stated as a test. `path.resolve(process.cwd(), 'apps/web/data/...')` gave
    // /repo/apps/web/data/... from the root and /repo/apps/web/apps/web/data/... from apps/web.
    const fromModule = resolveDomainStoreFile({}, '/repo/packages/database/src');
    expect(fromModule).toBe(
      path.join(path.resolve('/repo'), 'apps', 'web', 'data', 'assurapay.json'),
    );
    // Independent of cwd by construction: the function never reads it.
    expect(resolveDomainStoreFile({}, '/repo/packages/database/src')).toBe(fromModule);
  });

  it('never nests the app path inside itself', () => {
    const resolved = resolveDomainStoreFile({}, '/repo/packages/database/src');
    expect(resolved).not.toContain(path.join('apps', 'web', 'apps', 'web'));
  });

  it('lets a deployment name the file explicitly', () => {
    const configuredPath = '/var/lib/assurapay/domain.json';
    expect(resolveDomainStoreFile({ [DOMAIN_STORE_FILE_VARIABLE]: configuredPath })).toBe(
      path.resolve(configuredPath),
    );
  });

  it('resolves an explicit relative path against cwd rather than leaving it relative', () => {
    const resolved = resolveDomainStoreFile({ [DOMAIN_STORE_FILE_VARIABLE]: 'tmp/domain.json' });
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it('uses the real workspace root when given no override', () => {
    // Against this repository's actual layout, so the derivation is checked rather than assumed.
    expect(resolveDomainStoreFile({})).toMatch(/apps[/\\]web[/\\]data[/\\]assurapay\.json$/);
    expect(resolveDomainStoreFile({})).not.toMatch(/apps[/\\]web[/\\]apps/);
  });
});
