/**
 * Atlas — the typed input and proposal schemas.
 *
 * Atlas is the first agent in this product that a person can actually invoke, and everything it
 * emits is **untrusted proposal data**. A model produced it, possibly from an agreement document
 * that a counterparty wrote; neither the model nor the document carries any authority here. So the
 * schemas in this file are not conveniences for the caller, they are the boundary at which model
 * output stops being free-form text and becomes something the platform is willing to store.
 *
 * The rule the parsers follow is: refuse, never coerce. A proposal that is nearly right is rejected
 * whole rather than repaired, because a repaired proposal is one a human then approves believing a
 * model produced it. `AtlasProposalInvalid` names the field so the refusal is debuggable without
 * loosening it.
 *
 * ## Why the published vocabulary is narrower than what Atlas may propose
 *
 * The brief lets Atlas propose parties, obligations, milestones, criteria, evidence requirements,
 * dependencies, risks and payment triggers. `IntelligenceItem` — the thing the deterministic
 * publication engine actually stores — has a **closed** five-value vocabulary: `PARTY`,
 * `OBLIGATION`, `MILESTONE`, `KPI`, `PAYMENT_TRIGGER`.
 *
 * Rather than widen that vocabulary (a schema change well beyond this slice, and one that would make
 * every existing consumer handle item types it has never seen), completion criteria, evidence
 * requirements and dependencies ride as fields on the milestone they belong to, which is where they
 * are meaningful anyway. Risks are the one exception: they are kept on the durable Atlas proposal
 * record, where they are auditable, but they are **not** published as items, because there is no
 * honest item type for them. That is stated here rather than quietly dropped.
 */

export class AtlasProposalInvalid extends Error {
  constructor(readonly field: string, detail?: string) {
    super(detail ? `ATLAS_PROPOSAL_INVALID: ${field} — ${detail}` : `ATLAS_PROPOSAL_INVALID: ${field}`);
    this.name = 'AtlasProposalInvalid';
  }
}

/** Where a proposed item came from in the source document. Without one it is an assertion. */
export type AtlasSourceReference = {
  documentVersionId: string;
  section: string;
  page?: number;
};

export type AtlasParty = {
  role: string;
  legalName: string;
  sourceReferences: AtlasSourceReference[];
  confidence: number;
};

export type AtlasObligation = {
  owedBy: string;
  owedTo: string;
  description: string;
  sourceReferences: AtlasSourceReference[];
  confidence: number;
};

export type AtlasMilestone = {
  reference: string;
  title: string;
  /** What must be true for this milestone to be certifiable. */
  completionCriteria: string[];
  /** What a party must produce as proof. */
  evidenceRequirements: string[];
  /** References of milestones that must complete first. */
  dependsOn: string[];
  sourceReferences: AtlasSourceReference[];
  confidence: number;
};

export type AtlasPaymentTrigger = {
  /** The milestone reference whose completion releases money. */
  milestoneReference: string;
  amountMinor: number;
  currency: string;
  sourceReferences: AtlasSourceReference[];
  confidence: number;
};

export type AtlasRisk = {
  category: string;
  description: string;
  severity: 'INFO' | 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  sourceReferences: AtlasSourceReference[];
  confidence: number;
};

export type AtlasProposal = {
  parties: AtlasParty[];
  obligations: AtlasObligation[];
  milestones: AtlasMilestone[];
  paymentTriggers: AtlasPaymentTrigger[];
  risks: AtlasRisk[];
};

/** What a caller asks Atlas to read. Never the document body — a reference and a digest. */
export type AtlasProposalRequest = {
  contractId: string;
  contractVersionId: string;
  /** Storage reference to the agreement. The document is never inlined into a prompt. */
  contentReference: string;
  /** Digest of the content analysed, so the proposal can be tied to exactly what was read. */
  contentHash: string;
  counterpartyId: string;
};

const SEVERITIES = ['INFO', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AtlasProposalInvalid(field, 'must be non-empty text');
  return value;
}

function confidence(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new AtlasProposalInvalid(field, 'confidence must be within 0..1');
  return value;
}

/** Money is integer minor units, per CLAUDE.md. A fractional kobo is refused, never rounded. */
function minorUnits(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new AtlasProposalInvalid(field, 'must be a non-negative integer of minor units');
  return value as number;
}

function list(value: unknown, field: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AtlasProposalInvalid(field, 'must be a list');
  return value;
}

function strings(value: unknown, field: string): string[] {
  return list(value, field).map((entry, index) => text(entry, `${field}[${index}]`));
}

/**
 * Source references, parsed strictly.
 *
 * Unlike the contract-analysis adapter — which drops an unreadable reference and lets the engine's
 * own `SOURCE_REFERENCE_REQUIRED` refuse the finding — Atlas refuses here. The difference is what the
 * output is for: an analysis finding is advisory and a human reads it next, whereas an Atlas proposal
 * is the thing a human *approves* and a deterministic engine then publishes as authoritative. A
 * silently dropped citation would travel further than it should.
 */
function sourceReferences(value: unknown, field: string): AtlasSourceReference[] {
  const parsed = list(value, field).map((entry, index) => {
    const at = `${field}[${index}]`;
    if (!isRecord(entry)) throw new AtlasProposalInvalid(at, 'must be an object');
    const page = entry.page;
    if (page !== undefined && !Number.isSafeInteger(page))
      throw new AtlasProposalInvalid(`${at}.page`, 'must be an integer when present');
    return {
      documentVersionId: text(entry.documentVersionId, `${at}.documentVersionId`),
      section: text(entry.section, `${at}.section`),
      ...(page === undefined ? {} : { page: page as number }),
    };
  });
  if (parsed.length === 0) throw new AtlasProposalInvalid(field, 'at least one source reference is required');
  return parsed;
}

/**
 * Parses a model response into an Atlas proposal, or refuses it.
 *
 * The sandbox provider returns `{sandbox:true}` and no proposal, which is a legitimate answer
 * meaning "no model ran". It parses to an empty proposal rather than an error, so the governed chain
 * can be exercised end to end on a deployment with no model configured — which is every deployment
 * of this repository today. An empty proposal cannot be published, because the deterministic
 * publication engine refuses a version with no accepted item; that refusal is left where it is.
 */
export function parseAtlasProposal(output: unknown): AtlasProposal {
  if (!isRecord(output)) throw new AtlasProposalInvalid('output', 'must be an object');
  if (output.sandbox === true && output.proposal === undefined)
    return { parties: [], obligations: [], milestones: [], paymentTriggers: [], risks: [] };

  const root = output.proposal === undefined ? output : output.proposal;
  if (!isRecord(root)) throw new AtlasProposalInvalid('proposal', 'must be an object');

  const milestones: AtlasMilestone[] = list(root.milestones, 'milestones').map((entry, index) => {
    const at = `milestones[${index}]`;
    if (!isRecord(entry)) throw new AtlasProposalInvalid(at, 'must be an object');
    return {
      reference: text(entry.reference, `${at}.reference`),
      title: text(entry.title, `${at}.title`),
      completionCriteria: strings(entry.completionCriteria, `${at}.completionCriteria`),
      evidenceRequirements: strings(entry.evidenceRequirements, `${at}.evidenceRequirements`),
      dependsOn: strings(entry.dependsOn, `${at}.dependsOn`),
      sourceReferences: sourceReferences(entry.sourceReferences, `${at}.sourceReferences`),
      confidence: confidence(entry.confidence, `${at}.confidence`),
    };
  });

  const references = new Set(milestones.map((milestone) => milestone.reference));
  if (references.size !== milestones.length)
    throw new AtlasProposalInvalid('milestones', 'milestone references must be unique');

  for (const milestone of milestones)
    for (const dependency of milestone.dependsOn) {
      // A dependency on a milestone that does not exist would publish an unsatisfiable plan, and a
      // self-dependency an unstartable one. Both are refused here rather than discovered later by
      // whichever engine first tries to sequence the work.
      if (!references.has(dependency))
        throw new AtlasProposalInvalid('milestones.dependsOn', `unknown milestone ${dependency}`);
      if (dependency === milestone.reference)
        throw new AtlasProposalInvalid('milestones.dependsOn', `${dependency} depends on itself`);
    }

  const paymentTriggers: AtlasPaymentTrigger[] = list(root.paymentTriggers, 'paymentTriggers').map(
    (entry, index) => {
      const at = `paymentTriggers[${index}]`;
      if (!isRecord(entry)) throw new AtlasProposalInvalid(at, 'must be an object');
      const milestoneReference = text(entry.milestoneReference, `${at}.milestoneReference`);
      // The non-custody and certified-work-backed constraints both depend on a release being tied to
      // a milestone that can actually be certified. A trigger naming no real milestone is a release
      // with nothing to back it.
      if (!references.has(milestoneReference))
        throw new AtlasProposalInvalid(`${at}.milestoneReference`, `unknown milestone ${milestoneReference}`);
      return {
        milestoneReference,
        amountMinor: minorUnits(entry.amountMinor, `${at}.amountMinor`),
        currency: text(entry.currency, `${at}.currency`),
        sourceReferences: sourceReferences(entry.sourceReferences, `${at}.sourceReferences`),
        confidence: confidence(entry.confidence, `${at}.confidence`),
      };
    },
  );

  return {
    parties: list(root.parties, 'parties').map((entry, index) => {
      const at = `parties[${index}]`;
      if (!isRecord(entry)) throw new AtlasProposalInvalid(at, 'must be an object');
      return {
        role: text(entry.role, `${at}.role`),
        legalName: text(entry.legalName, `${at}.legalName`),
        sourceReferences: sourceReferences(entry.sourceReferences, `${at}.sourceReferences`),
        confidence: confidence(entry.confidence, `${at}.confidence`),
      };
    }),
    obligations: list(root.obligations, 'obligations').map((entry, index) => {
      const at = `obligations[${index}]`;
      if (!isRecord(entry)) throw new AtlasProposalInvalid(at, 'must be an object');
      return {
        owedBy: text(entry.owedBy, `${at}.owedBy`),
        owedTo: text(entry.owedTo, `${at}.owedTo`),
        description: text(entry.description, `${at}.description`),
        sourceReferences: sourceReferences(entry.sourceReferences, `${at}.sourceReferences`),
        confidence: confidence(entry.confidence, `${at}.confidence`),
      };
    }),
    milestones,
    paymentTriggers,
    risks: list(root.risks, 'risks').map((entry, index) => {
      const at = `risks[${index}]`;
      if (!isRecord(entry)) throw new AtlasProposalInvalid(at, 'must be an object');
      const severity = text(entry.severity, `${at}.severity`);
      if (!SEVERITIES.includes(severity as AtlasRisk['severity']))
        throw new AtlasProposalInvalid(`${at}.severity`, `unknown severity ${severity}`);
      return {
        category: text(entry.category, `${at}.category`),
        description: text(entry.description, `${at}.description`),
        severity: severity as AtlasRisk['severity'],
        sourceReferences: sourceReferences(entry.sourceReferences, `${at}.sourceReferences`),
        confidence: confidence(entry.confidence, `${at}.confidence`),
      };
    }),
  };
}

/**
 * A digest that survives storage.
 *
 * The approval digest is the hinge of the whole governed chain: it is what a human approves and what
 * publication must present back to consume that approval. So it has to be computed over the
 * proposal's *content*, not over one particular serialization of it.
 *
 * `JSON.stringify` is not that. It emits keys in insertion order, and PostgreSQL `jsonb` does not
 * preserve insertion order — it stores object keys sorted. A proposal written and read back therefore
 * stringifies differently, and the naive digest changes. The in-memory suite could not see this,
 * because there the stored object *is* the original object; the live PostgreSQL suite failed
 * immediately, with `APPROVAL_PROPOSAL_MISMATCH` on a proposal nobody had touched. Left unfixed,
 * every publication in production would have been refused as tampering.
 *
 * Object keys are sorted recursively; **array order is preserved**, because an array here is ordered
 * data — milestone sequence and dependency lists mean what their order says. Sorting those would make
 * two genuinely different proposals digest identically, which is the opposite failure and a worse one.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
  );
}

/** Canonical JSON for digesting. Stable across storage engines, drivers and languages. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** True when there is nothing to publish. Used to refuse early with a clear reason. */
export function isEmptyProposal(proposal: AtlasProposal): boolean {
  return (
    proposal.parties.length === 0 &&
    proposal.obligations.length === 0 &&
    proposal.milestones.length === 0 &&
    proposal.paymentTriggers.length === 0
  );
}

/** The output contract handed to the provider, so the model is told the shape it must return. */
export const ATLAS_OUTPUT_CONTRACT = [
  'Return JSON {"proposal":{',
  '"parties":[{"role":string,"legalName":string,"confidence":number,"sourceReferences":[{"documentVersionId":string,"section":string}]}],',
  '"obligations":[{"owedBy":string,"owedTo":string,"description":string,"confidence":number,"sourceReferences":[...]}],',
  '"milestones":[{"reference":string,"title":string,"completionCriteria":[string],"evidenceRequirements":[string],"dependsOn":[string],"confidence":number,"sourceReferences":[...]}],',
  '"paymentTriggers":[{"milestoneReference":string,"amountMinor":integer,"currency":string,"confidence":number,"sourceReferences":[...]}],',
  '"risks":[{"category":string,"description":string,"severity":"INFO"|"LOW"|"MODERATE"|"HIGH"|"CRITICAL","confidence":number,"sourceReferences":[...]}]',
  '}} and nothing else. Every item requires at least one source reference. Money is integer minor units.',
].join('');
