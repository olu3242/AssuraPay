# AssuraPay

**Execution assurance for agreements that must become verified outcomes.**

AssuraPay is an Execution Assurance Platform that transforms contractual obligations into governed, evidence-backed execution workflows and orchestrates settlement through certified financial institutions without ever taking custody of funds.

Built by **Zenith AI Automation Agency**.

## Why AssuraPay exists

Commercial agreements often fail after signature because scope, ownership, completion evidence, acceptance, and payment conditions remain fragmented. AssuraPay converts these obligations into measurable execution plans and connects certified completion to controlled, provider-neutral settlement orchestration.

AssuraPay is not a traditional contract-management system, project-management tool, payment processor, or escrow provider. It is the assurance layer connecting agreement, execution, certification, and settlement.

## Four platform pillars

1. **Execution Assurance** — Blueprints, milestones, Definition of Done, evidence, validation, acceptance, and certification.
2. **Settlement Assurance** — Eligibility, entitlement, invoices, funding, provider routing, payment instructions, and reconciliation.
3. **Intelligence** — Assurance indices, KPIs, forecasts, risk, portfolio performance, and executive dashboards.
4. **Trust** — Identity, authorization, compliance, audit, AI governance, and the Financial Provider Registry.

## Current maturity

AssuraPay is at **Stage 1 — Execution Assurance Prototype**. The repository contains working and tested domain flows for execution assurance, deterministic settlement preparation, and intelligence foundations. It uses a file-backed repository and demonstration UI/API surfaces; production identity, PostgreSQL persistence, certified financial-provider connectivity, and operational hardening remain Stage 2 work.

See [the maturity model](docs/product/EXECUTION_ASSURANCE_MATURITY_MODEL.md) for the evidence-based progression:

```text
Stage 1: Execution Assurance Prototype (current)
→ Stage 2: Enterprise Execution Platform MVP (next)
→ Stage 3: Enterprise Financial Execution Platform (target)
```

## Core constraint

AssuraPay never holds, pools, or has signing authority over customer funds. Certified Financial Providers and regulated external escrow providers remain custodians. AssuraPay produces governed release instructions and reconciles provider-confirmed outcomes.

## Repository guide

| Path | Purpose |
| --- | --- |
| `apps/web` | Next.js application, UI, and API routes |
| `packages/domain` | Domain services, controls, and tests |
| `packages/database` | Persistence boundary |
| `packages/shared` | Shared application types and utilities |
| `docs/product` | MVP scope, roadmap, and maturity model |
| `docs/architecture` | Target, execution, settlement, API, and event architecture |
| `docs/ENGINE_CATALOG.md` | Authoritative 60-engine bounded-context catalog |
| `docs/audit` | Current maturity assessment and validation baselines |
| `diagrams/architecture-diagram.svg` | Visual system architecture |

## Local validation

```bash
npm install
npm run certify
```

Trust Foundation Engines 01–05 live in bounded `identity`, `organizations`, `permissions`, `parties`, and `legal` workspaces. Run `npm run certify:batch1` for deterministic validation. Production certification additionally requires a live PostgreSQL/Supabase RLS test target and durable provider-backed persistence.

## License

Proprietary — Zenith AI Automation Agency. All rights reserved.
