# Authorization Certification

Deny-by-default, explicit denial, field masking, delegation bounds, authority limits, and segregation invariants are unit-covered.

## Permission enforcement

Unit-certified for membership resolution from the authoritative record, deny-by-default evaluation, explicit DENY precedence, expired and cross-user grants, membership required independently of permission, workspace/tenant context requirements, segregation-of-duties blocking, delegation to the permission authority rather than reimplementation, and boundary invariants. 25 cases in `packages/permissions/src/enforcement.test.ts`; run with `pnpm certify:authorization`.

Structural invariants asserted rather than reviewed: a caller-supplied membership list is discarded; the authority receives the resolved context and is not consulted when membership fails; the returned context gains no authorization-shaped field and no assurance elevation; the incoming context is not mutated.

With enforcement in place, workspace-scoped routes are operable again — membership now comes from the authoritative record rather than from a request header. The fail-closed gap the identity gateway opened is closed by data, not by relaxing the gateway.

