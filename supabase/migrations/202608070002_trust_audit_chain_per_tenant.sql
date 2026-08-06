-- The audit chain becomes per tenant, because a global chain and tenancy isolation cannot
-- both hold.
--
-- Found by running the application against forced Row Level Security. `audit` allocates a
-- chain position by reading the tail:
--
--   SELECT chain_position, integrity_hash FROM trust_audit_records ORDER BY chain_position DESC LIMIT 1
--
-- Under RLS that read is filtered by the policy. A caller in tenant B cannot see tenant A's
-- records, so it finds no tail, computes position 1, and collides with the row tenant A
-- already wrote there — a unique violation on every second tenant's first audited action.
--
-- Raising the position through an unfiltered read would have been the smaller change and the
-- wrong one. A single chain spanning tenants means tenant A's record is a load-bearing link
-- in tenant B's history: verifying B's chain requires reading A's rows, which the tenancy
-- boundary forbids and should forbid. Under a global chain each tenant sees a sequence with
-- gaps and predecessors it cannot resolve, so `verifyAuditChain` reports a broken chain for
-- data that is perfectly intact. Isolation and verifiability were mutually exclusive.
--
-- Per tenant, both hold: every tenant's chain starts at position 1, links only to its own
-- records, and verifies from within its own scope. Nothing about append-only or integrity
-- hashing changes — only what a position is counted within.

-- Replaces the global uniqueness. `coalesce` because a NULL tenant_id would otherwise be
-- distinct from every other NULL under a plain unique index, which would permit exactly the
-- duplicate positions this constraint exists to prevent.
ALTER TABLE trust_audit_records DROP CONSTRAINT trust_audit_records_chain_unique;

CREATE UNIQUE INDEX trust_audit_records_tenant_chain_unique
  ON trust_audit_records (coalesce(tenant_id, ''), chain_position);

-- The tail read, per tenant. Without this index the read behind every audited action becomes
-- a scan as history grows.
CREATE INDEX trust_audit_records_tenant_tail_idx
  ON trust_audit_records (coalesce(tenant_id, ''), chain_position DESC);

COMMENT ON INDEX trust_audit_records_tenant_chain_unique IS
  'One chain per tenant. A global chain cannot be verified from inside a tenant scope, because its predecessors lie outside it.';
