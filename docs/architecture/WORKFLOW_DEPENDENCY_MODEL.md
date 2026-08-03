# Workflow Dependency Model

Edges are typed as milestone, deliverable, approval or payment dependencies and point from prerequisite to dependent work. All endpoints must exist. Kahn topological sorting rejects any cycle; deterministic lexical ordering stabilizes equivalent graphs. Downstream impact is the transitive closure per node. Blocked-work analysis treats every incomplete prerequisite as blocking its immediate dependents, while the owning deterministic engine remains authoritative about actual state.

Schedule recommendations reuse this analysis and can only propose a topological sequence. They never update a Performance Blueprint or milestone schedule.
