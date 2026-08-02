# Architecture — AssuraPay Execution Assurance Platform

## 1. Product boundary

AssuraPay is an **Execution Assurance and Conditional Payment Platform**. It converts agreements into versioned execution plans, proves completion through evidence and acceptance, calculates financial entitlement, and instructs licensed custodians or payment providers to move funds.

AssuraPay remains structurally non-custodial:

- It does not hold or pool customer funds.
- It does not become the system of record for bank balances.
- It stores provider references and its own append-only assurance ledger.
- It sends governed release instructions only after configured conditions pass.
- The external bank, PSP or regulated escrow partner remains the financial custodian.

## 2. Canonical assurance loop

```text
Define → Agree → Plan → Activate → Execute → Measure → Evidence
→ Validate → Correct → Accept → Certify → Calculate → Fund
→ Authorize → Pay → Reconcile → Settle → Learn
```

## 3. Canonical business objects

The former single `AssuranceRequest` model is replaced by a connected aggregate chain:

```text
Contract
  → ContractVersion
  → PerformanceBlueprint
  → Milestone
  → DefinitionOfDonePackage
  → ExecutionWorkspace
  → EvidencePackage
  → AcceptanceDecision
  → CompletionCertificate
  → PaymentEligibility
  → FinancialEntitlement
  → ReleaseRequest
  → PaymentInstruction
  → ReconciliationRecord
  → FinalSettlementStatement
```

`AssuranceCase` is the optional cross-engine read model used to present this chain as one unified transaction. It is not a god aggregate and must not own every engine's state.

## 4. Six-wave architecture

1. **Trust Foundation (01–10)** establishes identities, workspaces, governance, verification, compliance, audit, notifications and configuration.
2. **Agreement Intelligence (11–20)** creates, negotiates, executes, stores, versions and structures agreements.
3. **Performance Blueprint (21–30)** converts agreements into milestones, deliverables, Definition of Done, criteria, dependencies, baselines and payment triggers.
4. **Execution Assurance (31–40)** activates work, measures progress, manages evidence, validates quality, controls changes and certifies completion.
5. **Settlement Assurance (41–50)** calculates entitlement, validates claims, confirms funding, authorizes release, executes payment and reconciles settlement.
6. **Enterprise Intelligence (51–60)** calculates assurance indices, KPIs, dashboards, forecasts, performance and governed AI recommendations.

The authoritative engine list is in `docs/ENGINE_CATALOG.md`.

## 5. Workspace and tenancy architecture

```text
Platform
  ├── PersonalWorkspace
  │    ├── Owner
  │    └── Invited collaborators
  └── OrganizationWorkspace
       ├── Legal entities
       ├── Business units
       ├── Departments
       ├── Projects
       ├── Teams
       └── Members and external parties
```

Every business record carries an explicit `tenant_id` and `workspace_id`. Organization-owned records additionally carry the relevant organization and organizational-unit references. The active workspace is explicit in every browser session and API request.

## 6. Configuration resolution

```text
Platform Default
→ Jurisdiction
→ Industry
→ Workspace
→ Organization
→ Legal Entity
→ Business Unit
→ Department or Project
→ Contract Type
→ Contract
→ Milestone
→ User Preference
```

Supported inheritance modes are `INHERIT`, `OVERRIDE`, `MERGE`, `APPEND`, `RESTRICT`, and `LOCKED`. Every material decision records an immutable `EffectiveConfigurationSnapshot` so historical decisions remain reproducible.

## 7. Object, record and field security

The platform uses four layers:

1. Object actions such as create, read, approve, certify, pay and close.
2. Record scopes such as own, assigned, team, department, business unit, organization and counterparty.
3. Field permissions for view, edit, export, report, search and AI processing.
4. State- and rule-driven behavior such as hide, mask, require, lock or request approval.

Explicit denials and segregation-of-duty controls override broad allowances.

## 8. Event-driven integration

Each engine owns its database writes and publishes versioned domain events through a transactional outbox. Consumers are idempotent and support retry, dead-letter handling and replay protection.

Canonical event families include:

`identity.*`, `organization.*`, `configuration.*`, `contract.*`, `blueprint.*`, `milestone.*`, `dod.*`, `execution.*`, `evidence.*`, `validation.*`, `acceptance.*`, `certification.*`, `eligibility.*`, `entitlement.*`, `release.*`, `payment.*`, `reconciliation.*`, `dispute.*`, `closure.*`, `kpi.*`, and `ai.*`.

## 9. Financial boundary

The platform maintains an append-only **settlement assurance ledger**, not a custodial wallet ledger. Provider balances and settlement status are reconciled from authenticated external callbacks and statements. A payment is not successful merely because an instruction was submitted.

States must distinguish:

`instruction_created → submitted → provider_accepted → processing → settled`

with failure branches for `failed`, `returned`, `cancelled`, and `reversed`.

## 10. AI architecture

All model calls pass through a governed AI Gateway, Prompt Registry, Model Registry, policy checks, guardrails, telemetry and evaluation. AI may extract, classify, summarize, recommend and forecast. It may not sign, accept, certify, approve payment, execute payment, issue a binding dispute decision or financially close a contract.

## 11. Unified assurance API

```http
GET /api/v1/milestones/{milestoneId}/assurance
```

The read model returns execution, evidence, validation, quality, issues, acceptance, certification, eligibility, entitlement, release, payment, reconciliation, disputes, assurance scores and blockers.

## 12. MVP vertical slice

The MVP is not complete until this real persistent loop passes end to end:

```text
Contract → Blueprint → Milestone → Definition of Done → Execution
→ Evidence → Validation → Corrective Action → Acceptance
→ Completion Certificate → Payment Eligibility → Entitlement
→ Invoice → Release Approval → Provider Payment → Reconciliation
```
