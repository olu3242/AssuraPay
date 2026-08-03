# Workflow Intelligence Security

- Callers authenticate through the existing gateway and supply active tenant/workspace context.
- Production storage uses RLS and append-only advisory artifacts.
- Canonical source identifiers and versions are retained; source aggregates are not copied into a new business-state store.
- Risk models require a governed gateway and return confidence, rationale, model identity/version and an unreviewed status.
- Financial exposure uses integer minor units. No provider credentials or payment primitives exist here.
- Escalation and schedule outputs are proposals; there are no automatic delivery or mutation side effects.

Production gates include RLS verification, model evaluation/drift monitoring, source-event authenticity, retention controls, API authorization tests and penetration testing.
