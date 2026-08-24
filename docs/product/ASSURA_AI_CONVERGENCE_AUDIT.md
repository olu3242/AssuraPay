# AssuraPay AI Convergence — Phase 1 audit

Measured against `main` @ `0e4bc1a`, working branch `claude/git-pull-cqc04u` @ `feb4174`, 49 migrations
(head `202608110022`), clean worktree. Every status below is derived from code that was read or a command
that was run, not from a document that describes intent.

## The finding that determines the whole convergence

**The governed AI runtime exists, is durable, is tested — and is reached by nothing.**

```
$ grep -rn "getAgentRuntime" apps/ packages/ --include=*.ts --include=*.tsx | grep -v agent-runtime-app.ts
(no output)
```

`apps/web/lib/agent-runtime-app.ts` composes the whole runtime — capability registry, agent registry,
prompt registry, AI gateway, context, memory, human approval, telemetry, governance — behind
`getAgentRuntime()`, and **no route, engine, component or test calls it**. There are 164 API routes and
not one of them mentions an agent, a proposal or an approval:

```
$ find apps/web/app/api -name route.ts | wc -l
164
$ grep -rln "agentProposal\|humanApproval\|AgentRuntime\|capabilityRegistry" apps/web/app/api/
(no output)
```

This is the same class of finding as RC1 Phase A, one layer up. There, the durable backend existed and
no browser could reach it. Here, the *governed AI substrate* exists and no part of the product can reach
it. The convergence work is therefore overwhelmingly **wiring and closing gaps, not building engines** —
which is what the directive's "convergence, not greenfield" instruction anticipated.

## Platform layer — what actually exists

| Component | Engine | Where | Status | Evidence |
| --- | --- | --- | --- | --- |
| Capability Registry | 62 | `agent-runtime/src/index.ts:98` | IMPLEMENTED | `CapabilityMode = READ \| PROPOSE \| EXECUTE_DETERMINISTIC`; `protectedState` + `aiAllowed` + `humanApprovalRequired` fields; DB CHECK `agent_capabilities_protected_state_may_only_propose` |
| Agent Registry | 63 | `:176` | IMPLEMENTED | `registered_agents` table; `ASSURAPAY_AGENT_IDENTITIES` (10 identities) |
| Prompt Registry | 64 | `:254` | IMPLEMENTED | `prompt_versions` table; variable presence enforced by `assurapay_prompt_variables_present` |
| AI Gateway | 65 | `:394` | IMPLEMENTED | model allowlist, per-tenant rate limit, timeout raced correctly, retries, provider fallback, cost ceiling |
| Context Engine | 66 | `:475` | IMPLEMENTED | `agent_context_snapshots`, append-only, checksummed |
| Execution Memory | 67 | `:526` | IMPLEMENTED | `agent_memory`, append-only |
| Human Approval | 68 | `:572` | IMPLEMENTED | `AGENT_ID_CANNOT_BE_HUMAN_ACTOR`; `PROPOSAL_HASH_MUST_BE_A_DIGEST`; DB CHECK `agent_approval_requests_no_self_approval` |
| Telemetry | 69 | `:669` | IMPLEMENTED | `agent_telemetry`, append-only |
| Governance | 70 | `:738` | IMPLEMENTED | `agent_governance_policies` |
| Agent Runtime | 61 | `:844` | IMPLEMENTED | `AgentRuntimeEngine`; `agent_executions` |
| **Composition into the app** | — | `apps/web/lib/agent-runtime-app.ts` | **DEAD** | composed, zero callers |
| **HTTP surface** | — | — | **MISSING** | no agent/AI route among 164 |
| **Model provider** | — | `registration.ts:94` | FOUNDATION_ONLY | only `sandboxModelProvider`, which performs no inference and says so |
| **Progressive Trust L0–L4** | — | — | **MISSING** | no `L0_VERIFIED`/`trustLevel`/`ProgressiveTrust` symbol anywhere in `packages/`, `apps/`, `supabase/` |

Persistence for all of the above is real: nine tables created by `202608110017`, three of them append-only,
proven by 31 live-PostgreSQL assertions in `wave6-batch-m-repository.postgres.test.ts`.

## The second AI path — a real duplication

`packages/agreement-intelligence` implements the governed pattern **correctly and independently**:

- `ContractAnalysisEngine` takes a `GovernedAnalysisGateway`, refuses `AI_ASSISTED`/`HYBRID` without one
  (`GOVERNED_AI_GATEWAY_REQUIRED`), records `modelId`/`modelVersion`/`promptVersion`/`inputHash`/`outputHash`,
  and rejects any non-`INFO` finding lacking a source reference (`SOURCE_REFERENCE_REQUIRED`).
- `AgreementIntelligenceEngine.publish` refuses while any item is `PENDING` (`HUMAN_REVIEW_REQUIRED`) and
  refuses if nothing was accepted (`ACCEPTED_INTELLIGENCE_REQUIRED`).

That *is* «AI proposes → human approves → deterministic engine publishes», already built and already
reachable through `POST /v1/agreement-intelligence` and `.../publish`.

But it reaches a model through **its own** `GovernedAnalysisGateway` interface, whose only implementation
is `deterministicAnalysisGateway` — a hardcoded stub returning one fixed finding. It does not pass through
`AiGatewayEngine`, so it is subject to **no model allowlist, no rate limit, no cost ceiling, no timeout, no
telemetry, and no capability check**. Two AI paths exist; the governed one is unreachable and the reachable
one is ungoverned. Converging these is the single highest-value change in this programme.

`DIRECT_PROVIDER_CALLS` is nonetheless **0** today — because no provider is configured at all.

## Agent matrix

`agents/agents.md` names 17 agents. `ASSURAPAY_AGENT_IDENTITIES` names 10, and they are not the same 10:
the code has `Settlement`, `Analytics`, `Advisor`, `Coordinator`, which the catalog does not describe; the
catalog has twelve the code does not name. No agent has a capability record, a prompt, a service, a route
or a test of its own — the identities are string literals in an allowlist.

Legend: Registry = named in `ASSURAPAY_AGENT_IDENTITIES`. Everything else is per-agent artefacts.

| Agent | Registry | Prompt | Capability | Service | Persistence | API/UI | Tests | E2E | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Atlas | ✅ | ✗ | ✗ | partial¹ | ✅² | partial¹ | partial¹ | ✗ | PARTIAL |
| Blueprint | ✅ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | FOUNDATION_ONLY |
| DoD | ✅ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | FOUNDATION_ONLY |
| Evidence | ✅ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | FOUNDATION_ONLY |
| Validation | ✅ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | FOUNDATION_ONLY |
| Risk / Risk & Assurance | ✅ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | FOUNDATION_ONLY |
| Change Impact | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Completion Readiness | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Entitlement Review | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Invoice Review | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Payment Risk | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Reconciliation | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Dispute Brief | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Executive Intelligence | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Onboarding | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Integration | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Ops Audit | ✗ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | MISSING |
| Settlement (code only) | ✅ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | DOCUMENTATION_ONLY⁴ |
| Analytics (code only) | ✅ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | DOCUMENTATION_ONLY⁴ |
| Advisor (code only) | ✅ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | DOCUMENTATION_ONLY⁴ |
| Coordinator (code only) | ✅ | ✗ | ✗ | ✗³ | ✅² | ✗ | ✗ | ✗ | DOCUMENTATION_ONLY⁴ |

1. Atlas's *function* — extract from an agreement, propose, review, publish — exists as
   `ContractAnalysisEngine` + `AgreementIntelligenceEngine`, reachable and tested, but it is not modelled as
   the Atlas agent, holds no capability record, and its gateway bypasses `AiGatewayEngine` (see above).
2. Persistence is generic: any agent's proposals fit `agent_executions` / `agent_approval_requests`. No agent
   has a dedicated store, and none is needed.
3. The *domain* engines these agents would advise all exist and are durable (blueprint, DoD, evidence,
   completion, entitlement, invoice, payment, reconciliation, dispute, analytics). What is missing is the
   agent-side proposal service that feeds them, not the deterministic engine behind it.
4. Named in the code allowlist with no counterpart in `agents/agents.md` — an identity nothing describes and
   nothing uses.

## Deterministic engines the agents must not bypass

Confirmed durable and certified on `main` (481 live-PostgreSQL assertions): agreement creation and
intelligence, performance blueprint, governance core (milestone, DoD, certification, payment triggers),
completion assurance, settlement assurance and execution, enterprise intelligence and analytics, audit
ledger, trust foundation (identity, organizations, permissions, parties, legal). Money columns are exact
`NUMERIC` with integrality and safe-range CHECKs since `202608110018`. Nothing in this programme should
re-implement any of it.

## Golden loop — reachable today?

The RC1 Phase A browser gate proves the first four steps end to end (`register → verify → sign in →
organization/workspace`, 7/7). Every later step has a durable engine and, in most cases, a route — but
**no step from `Atlas extraction` onward has ever been exercised through a browser**, and the three agent
steps in the loop (`Atlas`, `Evidence`, `Validation`) have no agent behind them.

## What the directive asks for that does not exist at all

- **Progressive Trust L0–L4** — absent entirely. No recommendation record, no deterministic policy, no
  level, no reason codes, no override trail.
- **A reachable governed AI path** — the runtime is dead code from the application's point of view.
- **Per-agent capabilities and prompts** — zero capability records and zero prompt versions are seeded.
- **AI-specific security suites** — no prompt-injection, hostile-document, proposal-tampering or
  approval-replay tests exist (`agent-runtime.security.test.ts` has 4 assertions, all about registration).
- **Evals** — no evaluation fixtures for extraction, evidence matching, anomaly detection or dispute packets.

## Honest scope note

This audit is Phase 1 of a programme whose full scope — 17 agents, Progressive Trust, an 18-step certified
golden loop, security and concurrency suites, evals, and live-model certification — is a multi-week
engineering effort, not a single change. What follows it in this branch is recorded in the final report
along with what remains, classified rather than glossed.
