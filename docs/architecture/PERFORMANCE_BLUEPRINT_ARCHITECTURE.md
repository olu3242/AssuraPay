# Performance Blueprint Architecture

`@assurapay/performance-blueprint` consumes a published Batch 4 agreement intelligence version by reference only — it does not re-derive or re-import it. The authority order is published intelligence → drafted blueprint → confirmed scope → confirmed deliverables → scheduled milestones → published Definition of Done package → activated blueprint.

Scope items and deliverables are draftable only while their parent blueprint is in `DRAFT`, and become immutable once confirmed. Milestones may only reference deliverables already `CONFIRMED`, and their combined value allocation is capped at 100% of the blueprint. Milestone sequencing is a directed acyclic graph with cycle rejection and critical-path computation, mirroring the Engine 07 milestone DAG in `packages/governance-core` but scoped to planning rather than execution state.

A blueprint can only move from `DRAFT` to `ACTIVE` once it has at least one confirmed scope item, at least one scheduled milestone, and a `PUBLISHED` Definition of Done package for every one of its milestones — no milestone can carry a payment-relevant gate without a governed completion definition behind it. Activating a blueprint supersedes any prior active blueprint for the same contract.

The in-memory `TrustPersistence` adapter certifies orchestration only. Live PostgreSQL RLS and the append-only mutation contract for `scope_items`, `deliverables` and `dod_packages` — whose in-memory equivalents mutate status in place — remain deployment gates, consistent with prior batches.
