# AssuraPay E2E Operations Runbook

**Document type:** Canonical SOP / operational memory  
**Status:** Controlled  
**Scope:** Local, test, preview, pilot and production environments  
**Rule:** A successful build is not E2E certification.

## 1. Purpose

This runbook defines the complete AssuraPay operational lifecycle, the evidence required at every boundary, document controls, change management, troubleshooting, recovery and certification. Operators and engineers should diagnose from business outcome back through authorization, application state, persistence and integrations rather than applying isolated UI fixes.

## 2. Canonical E2E flow

Environment/Deployment → Authentication → Persona & Workspace Authorization → Agreement & Document Creation/Versioning → Review → Approval → Activation → Execution → Payment Initiation → Provider/Webhook Confirmation → Escrow/Funds State → Milestone Execution → Evidence Submission → Buyer Acceptance/Rejection → Release Authorization → Reconciliation → Settlement → Agreement Completion → Audit/Reporting → Records/Retention.

Parallel exception flow:

Failure/Exception → Detect → Classify → Contain → Investigate → Governed Intervention → Retry/Compensate/Rollback → Reconcile → Verify → Audit → Close.

## 3. Standard stage contract

Every lifecycle stage MUST define and verify:

- purpose and protected business outcome;
- actor/persona and accountable owner;
- initiating trigger;
- prerequisites and permitted prior states;
- user-visible steps;
- API/governed-command/system steps;
- expected database records and RLS boundary;
- external integration behavior where applicable;
- expected UI, API, database and provider result;
- audit/evidence generated;
- unhappy paths and prohibited transitions;
- troubleshooting and recovery procedure;
- objective PASS/FAIL exit criteria.

## 4. Detailed lifecycle SOP

### 4.1 Environment and deployment

**Trigger:** A developer/operator needs to run or release AssuraPay.  
**Procedure:** identify Git SHA and target environment; install using the repository-declared pnpm workspace/package-manager contract; load environment-specific configuration from approved secret stores; verify Supabase/PostgreSQL connectivity; apply/verify migrations through the governed migration process; build all required workspace packages; deploy; execute runtime/API smoke tests and browser E2E checks.  
**Evidence:** Git SHA, build output, migration result, deployment ID, smoke/E2E results.  
**Failure:** package-manager mismatch, missing env vars, migration failure, connectivity failure, build/runtime failure.  
**Recovery:** stop promotion, diagnose the failing layer, restore configuration or rollback deployment/schema where safe, rerun verification. Never declare readiness from build success alone.

### 4.2 Authentication

**Trigger:** User signs up, signs in, resumes a session or authenticates for a protected action.  
**Procedure:** authenticate through the configured identity provider; establish a valid session; resolve the application user; validate expiry/refresh behavior; redirect to the permitted surface.  
**Expected:** authenticated identity maps to exactly the intended application user.  
**Troubleshoot:** session/token → application-user mapping → auth callback/redirect → environment configuration → provider logs.  
**PASS:** protected routes accept the valid user and reject anonymous/expired/invalid identities.

### 4.3 Persona, workspace, trust and permissions

Resolve workspace membership, role/persona, permission grants, scope and RLS before allowing a governed command. UI visibility MUST NOT be treated as authorization. Denied users must receive a controlled denial without state mutation. Verify membership, role, permission key, scope, resource ownership/state and PostgreSQL RLS when investigating 401/403 behavior.

### 4.4 Agreement and document creation/versioning

Create the agreement under an authorized workspace and parties; capture commercial terms, currency, milestones and required conditions; validate completeness; create the initial immutable/versioned agreement representation; link associated documents to workspace/agreement and actor; create audit evidence. Material contractual versions must not be silently overwritten.

### 4.5 Review and approval

Only eligible reviewers/approvers may act. Present the exact agreement/document version being approved. Record actor, version, decision and timestamp. A changed material version invalidates approval when policy requires reapproval. PASS requires approval state, audit evidence and unchanged approved version to agree.

### 4.6 Activation and execution

Validate required parties, approvals, permissions, current state and prerequisites before transition. Execute through the governed command boundary; reject invalid/replayed transitions; persist the new state and audit event atomically where required. Never force an agreement state by direct database editing.

### 4.7 Payment initiation

Validate agreement eligibility, amount/currency, payer, milestone/reference and idempotency key. Create the internal payment intent/reference, initiate the provider operation and preserve correlation identifiers. Do not mark funds confirmed merely because the client reports success.

### 4.8 Provider confirmation and webhooks

Authenticate/verify provider events, correlate them to the internal payment, enforce idempotency, persist provider references and update only permitted financial states. Duplicate/reordered webhooks must not duplicate value or state transitions. Failed processing enters controlled retry/reconciliation.

### 4.9 Escrow/funds state

Represent funds state according to AssuraPay's approved non-custodial/provider architecture. Financial state must derive from verified provider/internal evidence. Never manufacture funded/released state through UI flags or manual database mutation.

### 4.10 Milestones and evidence

Authorized parties create/execute eligible milestones. Sellers submit required evidence/documents with provenance, version, timestamps and agreement/milestone linkage. Evidence becomes part of the audit trail and is subject to access controls and retention requirements.

### 4.11 Buyer acceptance/rejection

Buyer reviews the correct milestone and evidence version and accepts or rejects with the required reason/evidence. Validate authorization and milestone state. Persist decision and audit event. Rejection follows the configured remediation/dispute path rather than release.

### 4.12 Release authorization

Verify funded state, milestone acceptance, absence of blocking dispute/hold, permission and all release policy conditions. Create a governed release authorization and provider instruction/reference. Release must be idempotent and independently reconcilable.

### 4.13 Reconciliation

Correlate provider transaction → internal payment/ledger record → agreement → milestone → release → settlement. Classify unmatched, duplicated, amount/currency-mismatched or stale records. Financial discrepancies remain open until evidence proves resolution; never conceal differences by manually changing the expected state.

### 4.14 Settlement

Confirm provider settlement evidence and update internal settlement state using the authorized reconciliation path. Record amount, currency, provider reference, timestamps and linked agreement/milestone. Settlement completion must be reconstructable from evidence.

### 4.15 Completion

An agreement completes only when required milestones and financial obligations reach permitted terminal states and no blocking exception/dispute remains. Persist completion evidence and make final records available according to persona/access policy.

### 4.16 Audit, reporting and retention

Preserve the chain of actors, commands, state transitions, document versions and financial/provider references. Reports should derive from authoritative records. Apply approved retention and access policies; preserve legal/financial/dispute evidence when a hold applies.

## 5. Document management SOP

Controlled document classes include agreements/contracts and amendments; approval/acceptance records; milestone definitions; evidence/attachments; payment/provider references; escrow/funds records; release authorizations; reconciliation and settlement records; dispute evidence/resolutions; incident/RCA records; deployment/certification evidence; audit reports; SOP/runbooks; ADRs; release notes and change records.

For each controlled document capture where applicable: document ID/type; workspace/agreement/milestone linkage; owner/source; version; status; created/updated timestamps; approval/signature/acceptance state; access/RLS policy; integrity/retention metadata; audit linkage; current/superseded relationship.

Contractual, payment, release, dispute and audit documents MUST be versioned/auditable and MUST NOT be silently overwritten.

## 6. Change management and change log SOP

Canonical change flow:

Change Request → Impact Assessment → Approval (when required) → Implementation → Tests → Deployment → E2E Verification → Change Log → SOP/Documentation Update → Closure.

Record material product, code, schema/migration, configuration, RLS/permission, workflow/state-machine, API, payment-provider, infrastructure and operational/documentation changes. Each record should contain change ID; timestamp; environment; release/version/Git SHA; requester/author; approver where required; affected workflow/component; reason; risk/impact; files/migrations/config affected; before/after behavior; tests; deployment result; rollback plan/result; incident/known limitations; evidence links; final status.

Maintain technical change history and user/operational release notes separately when appropriate.

## 7. Troubleshooting decision path

Use this order:

Symptom → User/Persona → Workflow Stage → Request/Command → Authorization → Application State → Database/RLS → External Provider → Audit/Logs → Root Cause → Recovery → Re-test → Evidence.

### Authentication/login loop
Check identity-provider result, callback URL, cookies/session, token expiry/refresh, application-user mapping, environment variables and redirect authorization.

### 401/403
Check authentication first, then workspace membership, role/persona, permission key, scope, resource state/ownership and RLS. Do not weaken authorization to make a failing test pass.

### 404
Confirm identifier and tenant/workspace scope, then determine whether RLS intentionally hides the resource before treating it as missing data.

### 409 / invalid transition
Inspect current workflow state, command idempotency/replay and allowed transition contract. Do not manually force the target state.

### 500
Capture correlation/request ID, inspect application/runtime logs, governed command result, database error and dependent provider. Correct root cause, then replay only when idempotency/compensation rules allow.

### Payment/webhook failure
Trace agreement → payment intent → provider transaction → webhook authenticity → correlation → idempotency → internal financial state → reconciliation. Never infer payment confirmation solely from the browser.

### Stuck milestone/release
Check agreement state, milestone state, evidence requirements, buyer decision, dispute/hold, funded state, permissions and release-policy predicates.

### Reconciliation mismatch
Compare amount/currency/reference/timestamps and provider lifecycle against internal records. Classify mismatch; resolve through governed correction/compensation and retain before/after evidence.

### Deployment/workspace install failure
Confirm packageManager/workspace configuration and Vercel install settings. For `EUNSUPPORTEDPROTOCOL: Unsupported URL Type "workspace:"`, ensure the deployment is not overriding the pnpm workspace with an incompatible npm install command; correct configuration, cleanly reinstall/build, redeploy and rerun smoke/E2E checks.

## 8. Incident and recovery SOP

Detect and assign severity → contain blast radius → preserve logs/evidence → identify affected users/agreements/payments → diagnose root cause → choose retry/compensation/rollback → execute authorized recovery → reconcile affected financial/workflow state → rerun E2E verification → document RCA/change record → close only with evidence.

Never delete audit evidence, silently mutate financial records, bypass RLS/permissions, or mark an incident resolved solely because the UI appears normal.

## 9. E2E certification gate

Certification must exercise the real business journey:

User → Auth → Workspace → Agreement → Document Version → Approval → Activation → Payment → Provider/Webhook → Funds State → Milestone → Evidence → Acceptance → Release → Reconciliation → Settlement → Completion → Audit.

For each stage collect UI/browser evidence where applicable, API/command result, PostgreSQL/RLS evidence, external-provider evidence where applicable, audit event and negative/failure-path result.

**PASS:** required stages and controls are proven with reproducible evidence.  
**BLOCKED:** an external dependency/environment prevents proof; record the blocker explicitly.  
**FAIL:** expected behavior/control is demonstrably incorrect.  

A compile/build pass alone MUST NOT be recorded as E2E PASS.

## 10. Documentation architecture

Use existing repository documentation domains where they already fit. Maintain operational SOPs under `docs/operations/`, certification evidence under `docs/certification/`, architecture under `docs/architecture/`, audit material under `docs/audit/`, governance under `docs/governance/`, and migrations under `docs/migration/`. Add focused subdirectories only when actual artifacts require them rather than creating empty taxonomy.

## 11. Definition of done for a change

A material change is complete only when implementation is committed; applicable tests pass; migration/configuration effects are verified; relevant E2E path is retested; rollback/recovery is understood; change history is recorded; impacted SOP/architecture/API documentation is updated; and known blockers/limitations are explicit.
