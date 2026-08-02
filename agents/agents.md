# AssuraPay Agent Catalog

All agents operate through the governed AI Gateway and domain APIs. None can directly mutate protected lifecycle, certification or payment state.

## Atlas — Agreement Intelligence Agent
Reads executed agreement versions and writes structured extraction proposals for parties, obligations, milestones, criteria, risks and payment triggers. Human or deterministic validation publishes the extraction.

## Blueprint Agent
Drafts Performance Blueprints, milestone decompositions, dependencies and ownership suggestions. It cannot approve or activate a Blueprint.

## DoD Agent
Proposes Definition of Done packages, measurable acceptance criteria, evidence requirements and gates. It cannot certify completion.

## Evidence Agent
Classifies evidence, extracts metadata, matches evidence to requirements and flags integrity or relevance concerns. It cannot mark mandatory evidence as finally verified.

## Validation Agent
Drafts test steps, summarizes results and identifies likely failure causes. It cannot pass or waive criteria.

## Risk Agent
Produces contract, counterparty, execution and settlement risk recommendations. Its output routes review but does not approve, block or release money by itself.

## Change Impact Agent
Maps proposed changes to scope, schedule, cost, criteria, evidence, risk and payment triggers. It cannot approve changes.

## Completion Readiness Agent
Summarizes certification blockers and recommended remediation. It cannot issue or revoke certificates.

## Entitlement Review Agent
Checks calculation inputs, unusual deductions, duplicate charges and contract-pricing consistency. It cannot approve entitlement.

## Invoice Review Agent
Extracts invoice fields, matches claims to entitlement and detects duplicates or anomalies. It cannot approve invoices.

## Payment Risk Agent
Flags unusual beneficiaries, release patterns and probable provider failures. It cannot approve or execute payment.

## Reconciliation Agent
Suggests likely matches and classifies variances. It cannot post final adjusting entries without authorized domain workflow.

## Dispute Brief Agent
Creates neutral summaries of positions and evidence and may draft non-binding resolution options. It cannot decide disputes.

## Executive Intelligence Agent
Generates role-aware narratives from governed KPI and assurance views. It is read-only with respect to transactional state.

## Onboarding Agent
Guides personal and organization setup, verification and configuration. It cannot approve KYC/KYB or publish critical configuration.

## Integration Agent
Assists developers with API, SDK and webhook configuration using non-production-safe access. It cannot access secrets or execute live payments.

## Ops Audit Agent
Reads immutable audit and event projections to explain what happened. It has no write authority.
