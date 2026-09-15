# Three-Path Intake Gate Matrix

| Gate | Required proof |
|---|---|
| Domain | intake + convergence unit tests green |
| Integration | intake -> existing ContractAuthoringEngine; failure atomicity; idempotency |
| Persistence | migrations apply; constraints/indexes verified |
| Isolation | live PostgreSQL RLS cross-workspace denial |
| HTTP | auth, permission, context, 409/422 mapping |
| UI | three starts -> one review surface |
| Accessibility | keyboard, labels, focus, error announcements |
| Browser | all three happy paths + negative lifecycle/isolation cases |
| Regression | existing agreement activation, milestone/evidence/payment gates remain green |
| Build | production Next.js/package build green |

No manual statement substitutes for executable evidence. Until CI reports these gates, the feature status is IMPLEMENTED_AWAITING_FULL_CERTIFICATION, not production-ready.
