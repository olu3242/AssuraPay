# Agreement Creation Architecture

The bounded `@assurapay/agreement-creation` package implements Engines 11–15 over the existing workspace, persistence, audit and outbox contracts. Authority flows from immutable published template and clause versions through document versions, immutable negotiation rounds, version-pinned human approval and an exact-document signature package.

Approval never signs. Signature never approves. AI-authored material is marked proposed and cannot approve or execute. Provider callbacks require HMAC verification, are idempotent by event identifier and must carry the approved document hash. Execution certificates use a deterministic canonical payload; revocation preserves the record.

The sandbox provider certifies orchestration without claiming a live trust-service provider. Live PostgreSQL and provider execution remain deployment gates.
