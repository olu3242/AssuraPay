# Engine to Code Map

| Engine | MVP status | Implementation location |
| --- | --- | --- |
| Identity and digital trust | Conditional implementation | `packages/identity`, auth APIs, identity/session migration |
| Organization and multi-tenant | Conditional implementation | `packages/organizations`, workspace APIs, tenancy/RLS migrations |
| Roles, permissions and governance | Conditional implementation | `packages/permissions`, permission API, governance migration |
| Party verification | Conditional implementation | `packages/parties`, party APIs, deterministic provider and migration |
| Legal governance | Conditional implementation | `packages/legal`, legal APIs and migration |
| Execution (06) | Implemented | `packages/governance-core` execution aggregate/history, execution APIs, governance-core migration |
| Milestone (07) | Implemented | `packages/governance-core` milestone DAG/critical path, milestone API, governance-core migration |
| Definition of Done (08) | Implemented | Immutable DoD versions/evaluations and DoD APIs in `packages/governance-core` |
| Certification (09) | Implemented | Human decisions/digital records and certification APIs in `packages/governance-core` |
| Payment Trigger (10) | Implemented | Governed authorization proposals and non-custodial orchestration contract in `packages/governance-core` |
| Contract Authoring (11) | Implemented | `packages/agreement-creation`, authoring APIs and agreement migration |
| Clause Intelligence (12) | Implemented | Published clause baselines, instances and explicit deviations |
| Negotiation (13) | Implemented | Participant-governed immutable proposal rounds |
| Approval Workflow (14) | Implemented | Version-pinned policies, authority, segregation and invalidation |
| Digital Execution (15) | Implemented | Exact-document packages, verified callbacks and execution certificates |
| AI Contract Analysis (16) | Implemented | Governed gateway and source-grounded immutable analysis runs |
| Contract Risk (17) | Implemented | Deterministic versioned risk assessments and validation |
| Contract Version (18) | Implemented | Immutable executed, amended and superseded versions |
| Contract Repository (19) | Implemented | Secure-store contract, classification-filtered search and legal hold |
| Agreement Intelligence (20) | Implemented | Human-reviewed source-grounded published structured versions |
| Performance Blueprint (21) | Implemented | `packages/performance-blueprint`, contract-scoped draft/activate lifecycle gated on scope, milestones and published Definition of Done |
| Scope Definition (22) | Implemented | Included/excluded scope items with assumptions, constraints and owner, immutable once confirmed |
| Deliverables (23) | Implemented | Quantity, quality, acceptance criteria and evidence requirements bound to included scope |
| Milestone Planning (24) | Implemented | Confirmed-deliverable scheduling, dependency DAG, cycle detection, critical path and bounded value allocation |
| Definition of Done (25) | Implemented | Deliverable-gated criteria, evidence, quality/compliance/risk/payment gates, versioned and published |
| Acceptance Criteria (26) | Implemented | `packages/performance-readiness`, measurable tolerance rules, test methods and retest configuration |
| Success Metrics (27) | Implemented | Milestone KPI/SLA/quality/timeliness/outcome/cost metrics with confirmed-weight allocation capped at 100% |
| Dependency Intelligence (28) | Implemented | Internal/external/vendor/customer/regulatory/funding dependencies with blocking-dependency queries |
| Payment Trigger (29) | Implemented | Contractual eligibility rules with deliverable/DoD/acceptance references and pure eligibility evaluation |
| Performance Baseline (30) | Implemented | One immutable planned baseline per milestone with append-only schedule/cost/scope variance records |
| Execution Orchestration (31) | Implemented | `packages/execution-orchestration`, one execution workspace per milestone with an assign/transition work-item lifecycle |
| Progress Measurement (32) | Implemented | Declared/evidenced/validated/accepted/financially-earned progress ladder, no stage or percent regression |
| Evidence Management (33) | Implemented | Deliverable-scoped mandatory requirements, chain-of-custody evidence packages and verification |
| Validation & Acceptance Testing (34) | Implemented | Manual/automated tests, conditional-pass notes, retest-on-prior-failure and criterion-level pass aggregation |
| Quality Assurance (35) | Implemented | Root-caused defect rework lifecycle and a quality gate blocked by any open critical defect |
| Inspection & Field Verification (36) | Implemented | `packages/completion-assurance`, checklist-covered inspections; reinspection requires a prior failure |
| Issue, Risk & Corrective Action (37) | Implemented | Escalation, CAPA and verified resolution; blocker query for open high/critical severity |
| Change Control (38) | Implemented | Draft/submit/decide/implement lifecycle for scope, schedule, cost, criteria, evidence and payment-trigger changes |
| Acceptance & Decision (39) | Implemented | Full/partial/conditional/provisional/rejected/deferred decisions, latest decision supersedes the prior |
| Completion Certification (40) | Implemented | Certificate issuance gated on quality, inspection, blocking issues and an active accepted decision |
| Audit and evidence ledger | Foundation only | Integrity-chained audit adapter and append-only PostgreSQL contract |
| Configuration engine | Contract only | Environment configuration and seed snapshot |
| Contract lifecycle | Implemented | Domain service and API routes |
| Blueprint and milestone | Implemented | Domain service and milestone read model |
| Definition of done | Implemented | Milestone DoD approval gate |
| Evidence management | Implemented | Evidence upload and completeness read model |
| Validation and acceptance | Implemented | Validation results and acceptance decisions |
| Completion certification | Implemented | Certificate issuance and verification |
| Payment eligibility | Implemented | Eligibility assessment from certificate |
