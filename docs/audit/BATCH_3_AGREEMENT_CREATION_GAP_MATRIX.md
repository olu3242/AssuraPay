# Batch 3 Agreement Creation Gap Matrix

| Capability | Engine | Baseline | Gap | Implementation | Security and tests |
| --- | --- | --- | --- | --- | --- |
| Versioned authoring | 11 | Partial legacy contract | No immutable templates/drafts | `ContractAuthoringEngine` | Workspace scope, locks, variables, visibility tests |
| Clause intelligence | 12 | Missing | No baselines/deviations | `ClauseIntelligenceEngine` | Internal guidance separation and deviation tests |
| Negotiation | 13 | Missing | No immutable rounds | `NegotiationEngine` | Participant and mandatory-position tests |
| Approval workflow | 14 | Conflicting single approval | No policy version/authority | `ApprovalWorkflowEngine` | Segregation, assurance and hash invalidation tests |
| Digital execution | 15 | Legal policy contract only | No signing boundary | `DigitalExecutionEngine` | Authority, HMAC, idempotency, witness and hash tests |
