import { FileAssuraStore, mayFabricateDemoData } from '@assurapay/database';
import { AssuraPayService, createSeedScenario } from '@assurapay/domain';

/**
 * The Engine 06-60 domain service.
 *
 * `FileAssuraStore.load()` refuses in a durable deployment, so this composition root cannot
 * serve one — see `packages/database/src/domain-store-environment.ts` for why refusing beats
 * serving. `persistence.domain-store-durability` is what replaces it.
 *
 * The seeding below fabricates a `tenant-demo` workspace and a full contract-to-payment
 * scenario. It previously ran on any environment whose `contracts` collection was empty, with no
 * condition, so an empty production dataset acquired invented tenants, milestones and
 * payment-eligibility records indistinguishable from real ones. It is now gated, and the gate is
 * checked rather than assumed: `mayFabricateDemoData` is false for every durable class.
 */
export async function getAssuraService() {
  const store = await FileAssuraStore.load();
  const snapshot = await store.getSnapshot();

  if (snapshot.contracts.length === 0 && mayFabricateDemoData()) {
    const scenario = createSeedScenario();
    snapshot.workspaces = [
      {
        id: 'workspace-demo',
        name: 'AssuraPay Demo Workspace',
        type: 'organization',
        tenantId: 'tenant-demo',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ];
    snapshot.organizations = [
      {
        id: 'org-demo',
        name: 'AssuraPay Demo Company',
        tenantId: 'tenant-demo',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ];
    snapshot.contracts = [scenario.contract];
    snapshot.blueprints = [scenario.blueprint];
    snapshot.milestones = [scenario.milestone];
    snapshot.dodPackages = [scenario.dod];
    snapshot.evidenceItems = scenario.evidence;
    snapshot.validationResults = scenario.validation;
    snapshot.acceptanceDecisions = [scenario.acceptance];
    snapshot.certificates = [scenario.certificate];
    snapshot.paymentEligibility = [scenario.paymentEligibility];
    await store.setSnapshot(snapshot);
    await store.upsertWorkspaces(snapshot.workspaces);
    await store.upsertOrganizations(snapshot.organizations);
    await store.upsertContracts(snapshot.contracts);
    await store.upsertBlueprints(snapshot.blueprints);
    await store.upsertMilestones(snapshot.milestones);
    await store.upsertDodPackages(snapshot.dodPackages);
    await store.upsertEvidence(snapshot.evidenceItems);
    await store.upsertValidation(snapshot.validationResults);
    await store.upsertAcceptance(snapshot.acceptanceDecisions);
    await store.upsertCertificates(snapshot.certificates);
    await store.upsertPaymentEligibility(snapshot.paymentEligibility);
  }

  return { store, service: new AssuraPayService(store) };
}
