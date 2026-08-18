import type { TrustPersistence } from '@assurapay/shared';

/**
 * The milestone assurance case, read from durable state.
 *
 * CLAUDE.md permits `AssuranceCase` "only as a cross-engine read model", and that is exactly what this is:
 * it writes nothing, owns nothing, and every number it reports is counted from a record some engine wrote.
 * It lives in the composition root rather than in a package so that no engine can import it — a read model
 * an engine depends on has stopped being a read model.
 *
 * ## What it replaces, and why the shape changed
 *
 * `AssuraPayService.getAssuranceReadModel` served `GET /v1/milestones/[id]/assurance` from the JSON
 * snapshot. Most of what it returned was invented rather than measured:
 *
 *     declared: 90                              // a constant
 *     evidenced: evidence.length * 30           // arithmetic with no source
 *     required: 2                               // a constant, for every milestone
 *     completenessScore: evidence.length * 50   // 50% complete per file, capped
 *     criticalDefects: 0                        // never computed
 *     issues: { open: 0, blockingAcceptance: 0, ... }   // all four constants
 *
 * Those fields are **not carried forward**. Reproducing them over durable collections would move a
 * fabrication into the durable path, which is the thing this whole programme exists to remove, and it would
 * do it on the endpoint whose name is `assurance`. A caller reading `declared: 90` had no way to know the
 * number described nothing. Where a field has a durable source it is counted; where it does not, it is gone
 * and named here as gone.
 *
 * `criticalDefects` is the one field that changed from a constant into a real count, because `issueRecords`
 * carries a `severity` and a `status` and nothing was reading them. `evidence.required` is dropped rather
 * than counted from `evidenceRequirements`: requirements are defined per deliverable, so the count for a
 * milestone depends on which deliverables its work items cover, and reporting a requirement total that does
 * not match that set would understate what is outstanding.
 *
 * ## How a milestone reaches its evidence
 *
 * The durable chain is not flat. Evidence, validation, acceptance and issues all key on `workItemId`, while
 * the definition-of-done evaluation, the certificate and the payment eligibility key on `milestoneId`. The
 * join between them is the execution workspace:
 *
 *     milestone → executionWorkspaces.milestoneId → workItems.executionWorkspaceId → evidencePackages,
 *                 validationTests, acceptanceDecisions, issueRecords .workItemId
 *
 * so a milestone with no execution workspace has no evidence rather than an error, which is the honest
 * answer: work that has not been opened has not been evidenced.
 *
 * Row-level security confines every read below to the caller's tenant and workspace, so nothing here filters
 * on either. The store is the boundary; repeating it as a predicate would suggest the predicate is what
 * enforces it.
 */

export type AssuranceCase = {
  milestoneId: string;
  status: string;
  readiness: {
    /** True when the definition of done's mandatory criteria all passed. */
    mandatoryDefinitionOfDonePassed: boolean;
    manualReviewRequired: boolean;
    criteriaEvaluated: number;
    criteriaPassed: number;
  };
  evidence: {
    submitted: number;
    verified: number;
    rejected: number;
  };
  validation: {
    total: number;
    passed: number;
    failed: number;
    conditional: number;
    waived: number;
  };
  quality: {
    openIssues: number;
    criticalDefects: number;
  };
  acceptance: {
    decision: string | null;
    conditions: string[];
  };
  certification: {
    certified: boolean;
    certificateId: string | null;
    certificateNumber: string | null;
  };
  paymentEligibility: {
    assessed: boolean;
    eligible: boolean;
    blockers: string[];
  };
  /** Every reason this milestone is not payable, gathered from the records that decide it. */
  blockers: string[];
};

type Row = Record<string, unknown>;

const ACCEPTABLE_TEST_RESULTS = new Set(['PASS', 'CONDITIONAL_PASS', 'WAIVED']);
const OPEN_ISSUE_STATUSES = new Set(['OPEN', 'ESCALATED', 'CAPA_IN_PROGRESS']);

function text(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

function strings(row: Row, key: string): string[] {
  const value = row[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Reads the assurance case for one milestone.
 *
 * Refuses when the milestone does not exist in the caller's scope. A milestone that cannot be found and a
 * milestone with nothing recorded against it are opposite answers — the first means the caller asked about
 * something that is not there, and returning an empty case for it would report an unblocked, uncertified,
 * un-evidenced milestone as though it had been measured.
 */
export async function readAssuranceCase(
  store: TrustPersistence,
  milestoneId: string,
): Promise<AssuranceCase> {
  const milestones = await store.list<Row>('governedMilestones');
  const milestone = milestones.find((entry) => entry.id === milestoneId);
  if (!milestone) throw new Error('MILESTONE_NOT_FOUND');

  const executions = await store.list<Row>('executionWorkspaces');
  const workspaceIds = new Set(
    executions.filter((entry) => entry.milestoneId === milestoneId).map((entry) => entry.id as string),
  );
  const workItems = await store.list<Row>('workItems');
  const workItemIds = new Set(
    workItems
      .filter((entry) => workspaceIds.has(entry.executionWorkspaceId as string))
      .map((entry) => entry.id as string),
  );
  const forThisMilestone = (row: Row) => workItemIds.has(row.workItemId as string);

  const evidence = (await store.list<Row>('evidencePackages')).filter(forThisMilestone);
  const tests = (await store.list<Row>('validationTests')).filter(forThisMilestone);
  const issues = (await store.list<Row>('issueRecords')).filter(forThisMilestone);

  // The most recent ACTIVE decision. `decide()` supersedes the previous one rather than editing it, so
  // reading any ACTIVE row would report a superseded decision as current on a milestone decided twice.
  const acceptance = (await store.list<Row>('acceptanceDecisions'))
    .filter((entry) => forThisMilestone(entry) && entry.status === 'ACTIVE')
    .sort((left, right) => String(left.decidedAt).localeCompare(String(right.decidedAt)))
    .at(-1);

  const evaluation = (await store.list<Row>('dodEvaluations'))
    .filter((entry) => entry.milestoneId === milestoneId)
    .sort((left, right) => String(left.evaluatedAt).localeCompare(String(right.evaluatedAt)))
    .at(-1);

  // CERTIFIED only. A REVOKED certificate is not a weaker certification, it is the absence of one, and
  // treating the row's existence as certification is how a revoked certificate authorises a release.
  const certificate = (await store.list<Row>('completionCertificates')).find(
    (entry) => entry.milestoneId === milestoneId && entry.status === 'CERTIFIED',
  );

  const eligibility = (await store.list<Row>('paymentEligibilities'))
    .filter((entry) => entry.milestoneId === milestoneId)
    .sort((left, right) => String(left.evaluatedAt).localeCompare(String(right.evaluatedAt)))
    .at(-1);

  const results = Array.isArray(evaluation?.results) ? (evaluation.results as Row[]) : [];
  const openIssues = issues.filter((entry) => OPEN_ISSUE_STATUSES.has(String(entry.status)));

  const blockers: string[] = [];
  if (!evaluation) blockers.push('DEFINITION_OF_DONE_NOT_EVALUATED');
  else if (evaluation.mandatoryPassed !== true) blockers.push('DOD_NOT_SATISFIED');
  if (evaluation?.manualReviewRequired === true) blockers.push('MANUAL_REVIEW_REQUIRED');
  if (tests.some((entry) => !ACCEPTABLE_TEST_RESULTS.has(String(entry.result))))
    blockers.push('VALIDATION_FAILED');
  if (openIssues.some((entry) => entry.severity === 'CRITICAL')) blockers.push('CRITICAL_DEFECT_OPEN');
  if (!acceptance) blockers.push('NOT_ACCEPTED');
  if (!certificate) blockers.push('CERTIFICATION_REQUIRED');
  // The engine's own reasons, appended rather than recomputed: `assess()` decides eligibility and this read
  // model is not a second opinion on it.
  if (eligibility) blockers.push(...strings(eligibility, 'blockers'));
  else blockers.push('PAYMENT_ELIGIBILITY_NOT_ASSESSED');

  return {
    milestoneId,
    status: text(milestone, 'state') ?? text(milestone, 'status') ?? 'UNKNOWN',
    readiness: {
      mandatoryDefinitionOfDonePassed: evaluation?.mandatoryPassed === true,
      manualReviewRequired: evaluation?.manualReviewRequired === true,
      criteriaEvaluated: results.length,
      criteriaPassed: results.filter((entry) => entry.passed === true).length,
    },
    evidence: {
      submitted: evidence.length,
      verified: evidence.filter((entry) => entry.status === 'VERIFIED').length,
      rejected: evidence.filter((entry) => entry.status === 'REJECTED').length,
    },
    validation: {
      total: tests.length,
      passed: tests.filter((entry) => entry.result === 'PASS').length,
      failed: tests.filter((entry) => entry.result === 'FAIL').length,
      conditional: tests.filter((entry) => entry.result === 'CONDITIONAL_PASS').length,
      waived: tests.filter((entry) => entry.result === 'WAIVED').length,
    },
    quality: {
      openIssues: openIssues.length,
      criticalDefects: openIssues.filter((entry) => entry.severity === 'CRITICAL').length,
    },
    acceptance: {
      decision: acceptance ? (text(acceptance, 'decision') ?? null) : null,
      conditions: acceptance ? strings(acceptance, 'conditions') : [],
    },
    certification: {
      certified: Boolean(certificate),
      certificateId: certificate ? (text(certificate, 'id') ?? null) : null,
      certificateNumber: certificate ? (text(certificate, 'certificateNumber') ?? null) : null,
    },
    paymentEligibility: {
      assessed: Boolean(eligibility),
      eligible: eligibility?.eligible === true,
      blockers: eligibility ? strings(eligibility, 'blockers') : [],
    },
    // De-duplicated: the engine's blockers and this model's own can name the same condition, and a caller
    // counting the list would otherwise double-count a single unmet requirement.
    blockers: [...new Set(blockers)],
  };
}
