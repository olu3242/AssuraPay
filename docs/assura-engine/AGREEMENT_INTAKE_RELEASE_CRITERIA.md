# Release criteria

Merge criteria: code review confirms no parallel Agreement lifecycle; repository test/build gates green; migrations conform to existing database conventions.

Pilot criteria: live PostgreSQL/RLS proof, authenticated three-path browser flows, accessibility, observability and failure recovery proven.

Production criteria: payment/activation regressions green, rollback exercised, security review of artifact access/provenance complete, and no unresolved HIGH risk in the intake risk register.
