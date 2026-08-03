# Batch 9 Settlement Assurance Gap Matrix

| Engine | Baseline | Implemented boundary | Primary control |
| --- | --- | --- | --- |
| 41 Payment Eligibility | Missing | Certificate-and-trigger-gated eligibility assessment | Ineligible unless certificate is certified and trigger is eligible |
| 42 Financial Entitlement | Missing | Gross/variations/retention/tax/penalty into a locked net payable | Integer minor units only; negative net payable rejected |
| 43 Invoice & Claim Management | Missing | Duplicate-rejecting, auto-matching invoice lifecycle | Approval requires an exact-amount match against the entitlement |
| 44 Escrow & Funding Assurance | Missing | External custody references and capped fund reservations | Confirmation only through the provider's own gateway |
| 45 Conditional Release Orchestration | Missing | Full/partial/staged release requests | Never authorizes or moves funds — evaluation only |
