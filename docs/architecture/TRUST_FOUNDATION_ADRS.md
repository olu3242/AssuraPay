# Trust Foundation Architecture Decisions

1. Identity-provider boundary: provider subject references are hashed and domain identity is provider-neutral.
2. Global identity and membership separation: authentication never implies workspace authorization.
3. Explicit active context: clients cannot establish access with an unchecked workspace identifier.
4. Tenant isolation: server checks and PostgreSQL RLS are both required.
5. Authorization: deny-by-default with explicit deny precedence and explainable sources.
6. Authority: delegation cannot exceed current delegator permissions; integer minor-unit limits and segregation rules apply.
7. Verification: immutable provider results with deterministic CI adapters and tokenized sensitive references.
8. Legal governance: immutable published versions, exact acceptance evidence, and authority-controlled legal holds.
