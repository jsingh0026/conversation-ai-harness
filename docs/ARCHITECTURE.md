# Architecture & Build Plan

> Design doc for the Conversation AI Agent Harness. Read alongside [`ASSIGNMENT.md`](./ASSIGNMENT.md).
> **Status: implemented** (phases 0–7). See [`../README.md`](../README.md) for how to run it.

## 1. Design goals (from the eval criteria)

The scoring rewards *clean seams* and *evidence*. Every decision below optimizes for:

1. **Adding a 4th provider or 3rd skill is cheap** → hard interfaces, registries, zero core edits.
2. **Closes the loop in a real sandbox** → webhook → decide → execute → reply, idempotent.
3. **Selective RAG** → chit-chat/skill turns never touch the vector store.
4. **Everything is traceable** → one trace object per turn answers "why did it say that?".
5. **Evidence over vibes** → one-command evals, negative cases, per-provider latency.

## 2. High-level flow

```
                    ┌─────────────────────────────────────────────────────────┐
Inbound webhook ──▶ │  Server (Fastify)                                        │
(HighLevel CRM)     │   • verify + parse  • idempotency dedupe                 │
                    │   • enqueue per-conversation (serialize rapid msgs)      │
                    └───────────────┬─────────────────────────────────────────┘
                                    ▼
                    ┌─────────────────────────────────────────────────────────┐
                    │  Orchestrator (the "harness")                            │
                    │   1. load convo state + contact + bot-enabled flag       │
                    │   2. assemble prompt (system + history + tools)          │
                    │   3. tool-use loop over the LLMProvider:                 │
                    │        ├─ direct answer  → chit-chat (NO retrieval)      │
                    │        ├─ search_kb tool → RAG retrieve → grounded answer│
                    │        ├─ skill tool     → execute skill                 │
                    │        └─ handover tool  → stop bot + mark CRM           │
                    │   4. send reply (Conversations API)                      │
                    │   5. emit Trace                                          │
                    └───┬───────────────┬───────────────┬─────────────────────┘
                        ▼               ▼               ▼
                 Providers         RAG pipeline      Skills registry
              (Claude/OpenAI/    (embed+index+     (updateContact /
               Gemini adapters)   retrieve)         handover / booking)
                        │               │               │
                        └───────────────┴───────────────┴──▶ CrmClient (real | mock)
                                        │
                                        └──▶ Trace collector ──▶ Langfuse | JSON + CLI
```

## 3. Key architectural decisions

### 3.1 Decision model: one tool-use loop, retrieval-as-a-tool

The "what should the agent do?" decision is **not** a separate hand-rolled router. Instead the LLM
sees a set of **tools** and the harness runs a bounded tool-use loop:

- `search_knowledge_base(query)` — retrieval is a tool the model calls only when it needs facts.
- `update_contact_field(...)`, `request_human_handover(...)`, `book_appointment(...)` — the skills.
- No tool call → the model answers directly (chit-chat).

**Why:** it unifies "decide when to retrieve" and "decide which skill" under one mechanism, makes the
RAG-trigger decision *explicit and measurable* (did it call `search_kb`? vs. gold label), and keeps
non-RAG turns to a **single LLM round-trip** (hits the p50 ≤ 3s target). Trade-off: a RAG turn costs
two round-trips (decide → retrieve → answer). Documented alternative: a cheap heuristic/classifier
pre-gate for even lower latency — we keep the seam so it can be added, and we eval trigger quality
either way.

### 3.2 Provider abstraction — thin seam over the Vercel AI SDK

We keep a thin, own-able `LLMProvider` seam but implement it **over the Vercel AI SDK** rather than
hand-rolling three raw SDK adapters. The AI SDK already normalizes tool-calling, streaming, and
`usage` across Claude (`@ai-sdk/anthropic`), OpenAI (`@ai-sdk/openai`), and Gemini
(`@ai-sdk/google`) — so we delegate wire-normalization to a library that does it well and spend our
effort on the harness.

```ts
interface LLMProvider {
  readonly name: string;                                  // 'claude' | 'openai' | 'gemini'
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>;
}

interface GenerateRequest {
  system: string;
  messages: Message[];            // canonical role/content, incl. tool results
  tools?: ToolSpec[];             // canonical tool defs (Zod/JSON-schema)
  toolChoice?: 'auto' | 'required' | 'none';
  model: string; temperature?: number; maxTokens?: number;
}

interface GenerateResult {
  text: string | null;
  toolCalls: ToolCall[];          // {id, name, args} — normalized by the AI SDK
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'stop' | 'tool_use' | 'length' | 'error';
  raw: unknown;                   // provider-native response, for the trace
}
```

Each provider is a tiny module that resolves an AI SDK **model handle** (`anthropic(modelId)` etc.)
from config and maps our canonical `GenerateRequest`/`GenerateResult` to the SDK's
`generateText`/`streamText` shape. Selection is config: `LLM_PROVIDER=claude|openai|gemini` +
per-provider model — **switching is a config change, not a code change.** The seam is deliberately
kept (not "just call the SDK") so a **4th provider or a non-AI-SDK backend** stays a one-file add, and
so all calls flow through one place for tracing, typed errors (`RateLimitError`, `AuthError`,
`ContextLengthError`, `TransientError`), and uniform retry/backoff. Embeddings are a *separate*
`Embedder` interface (chat provider ≠ embed provider), also over the AI SDK's `embed`/`embedMany`.

### 3.3 Skills framework

```ts
interface Skill<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;   // shown to the LLM for selection
  readonly parameters: ZodSchema; // typed args — surfaced to the model AND validated before execute
  execute(input: I, ctx: SkillContext): Promise<SkillResult<O>>;
}
```

Each skill is one file exporting a descriptor; a **registry auto-collects** them (array/glob), so
**adding a skill = drop a file + one array entry — no core edits.** The `parameters` Zod schema is
surfaced to the model as the tool's input schema (via the AI SDK's `tool({ parameters })`), so arg
validation and forced JSON are provider-native — not hand-parsed after the fact. `SkillContext` gives
a skill the `CrmClient`, contact/conversation, and the trace collector. An **allowlist** controls
which skills a given agent mode may call, and skills can be **gated dynamically at request time**
(e.g. expose a risky skill only when a condition holds).

### 3.4 CRM client (mockable)

A single `CrmClient` interface wraps HighLevel: `sendMessage`, `getContact`, `updateContact`,
`addTag`, `assignOwner`, `getFreeSlots`, `createAppointment`, plus bot on/off state. Two
implementations: `HighLevelClient` (real sandbox, OAuth) and `MockCrmClient` (in-memory, deterministic).
We build and eval against the mock, then swap to real via config — no orchestrator changes.

### 3.5 RAG pipeline

- **KB:** 10–20 markdown docs for a fictional business (proposed: **a real-estate brokerage** — fits
  the `budget` / `preferred time` contact fields, appointment booking, and a rich FAQ KB).
- **Ingest (`npm run ingest`, standalone CLI):** load docs → chunk (**heading-aware**: split on
  headings first, then a ~500-token sliding window with overlap for over-long sections) → embed →
  persist. Each chunk carries a SHA-256 `content_hash` so re-ingest **skips unchanged sources**.
  Default store is a **flat in-memory index**: embeddings written to a JSON artifact at ingest,
  loaded into memory at boot for sub-ms cosine search — zero infra for 10–20 docs. **pgvector**
  (HNSW + `vector_cosine_ops`) is a documented swap behind the same `VectorStore` interface for scale-up.
- **Retrieve:** embed query → top-k cosine → **score threshold**. If the best score < threshold, the
  retriever returns an **explicit "KB has no answer" result** (not weak snippets) — a hard signal the
  agent uses to decline or hand over, rather than trusting the prompt alone. Retrieved chunks (with
  scores + ids) flow into the trace and can back a citation. System prompt reinforces *answer only
  from retrieved context; if it's not there, say so*.

### 3.6 Idempotency & rapid messages

- **Idempotency:** dedupe by webhook/message id (LRU + optional persistence) → drop duplicate deliveries.
- **Ordering:** a per-`conversationId` async mutex/queue serializes back-to-back messages. Optional
  short debounce coalesces a burst into one turn (documented trade-off: latency vs. context freshness).

### 3.7 Tracing

One `Trace` per turn, accumulated through execution:

```
Trace { turnId, conversationId, startedAt, latencyMs, tokens,
  input,
  steps: [ { type: 'provider_call'|'retrieval'|'skill'|'crm_call',
             latencyMs, model?, tokens?, input, output } ],
  retrieval?: { query, chunks: [{docId, score, text}] },
  decision: 'chitchat'|'knowledge'|'skill:<name>'|'handover',
  reply }
```

**Viewing surfaces.** Our `Trace` is the canonical, self-owned record. It fans out to viewers
through a pluggable `TraceExporter` interface (same extensibility philosophy as providers/skills —
adding a backend is registration, not core edits):

- **Langfuse (primary UI):** each turn is exported as a Langfuse trace, with one nested span per
  step — `provider_call` (model, prompt, tokens, latency), `retrieval` (query + chunks + scores),
  `skill` (input/output + CRM calls). This gives a polished LLM-native timeline, token/cost/latency
  dashboards, and the ability to attach eval scores to real turns — the reviewer clicks a turn and
  sees exactly *why the agent said that*. Runs against **self-hosted Langfuse** (`docker compose up`,
  OSS, no signup) or Langfuse Cloud via env config; `LANGFUSE_*` keys are optional — absent = disabled.
- **Local JSON + CLI (always-on fallback):** every trace is also written as JSON (one file per turn,
  gitignored) and printable via `npm run trace <id>`. This keeps the harness fully inspectable with
  **zero external infra**, drives the eval suite's latency/groundedness numbers directly, and means a
  reviewer who doesn't want to stand up Langfuse still gets the full picture.

Goal either way: answer "why did it say that?" in under a minute. The Langfuse exporter is an
opt-in enhancement layered on the canonical Trace — we never depend on it for correctness or evals.

## 4. Module layout

```
src/
  config/         env schema (zod) + provider/model config + feature flags
  server/         fastify app, webhook route, health, /traces/:id
  orchestrator/   turn loop, decision, idempotency store, per-convo queue
  providers/      LLMProvider seam over the Vercel AI SDK (claude/openai/gemini) + registry
  llm/            canonical types (Message, ToolSpec, ToolCall, usage), typed errors, retry
  rag/            Embedder, chunker, vector store, retriever, ingest script
  skills/         Skill interface + registry + updateContact / handover / appointment
  crm/            CrmClient interface + HighLevelClient + MockCrmClient
  trace/          Trace types, collector, TraceExporter interface, Langfuse + JSON/CLI exporters
  util/           logger, async mutex, idempotency LRU, relative-date parsing
evals/
  cases/          *.json datasets per behavior (20–30 each)
  runners/        per-behavior runners
  run.ts          one entrypoint  → npm run eval
  report.ts       per-provider table + failure dump
kb/               10–20 markdown docs (fictional business)
docs/             ASSIGNMENT.md, ARCHITECTURE.md, SETUP.md
```

## 5. Phased build plan

| Phase | Deliverable | Exit criteria |
|------|-------------|---------------|
| **0. Setup** | tsconfig, deps, eslint/prettier, vitest, env schema, Fastify `/health` + webhook stub, MockCrm | `npm run dev` boots; webhook stub returns 200; CI-lint passes |
| **1. Providers** | `LLMProvider` + Claude/OpenAI/Gemini adapters, tool translation, typed errors, retry | `providers:smoke` gets a tool call back from all three |
| **2. Orchestration** | tool-use loop, idempotency, per-convo queue, trace collector, mock send | chit-chat turn goes webhook→reply, traced, under latency target |
| **3. RAG** | KB docs, chunk/embed/index, `search_kb` tool, threshold + decline | grounded answer + correct decline; chit-chat skips retrieval |
| **4. Skills** | updateContact, handover (bot-off + tag/owner), appointment booking (slots, relative dates, races) | all three fire correctly; negatives don't fire |
| **5. Trace polish** | full per-step trace, `TraceExporter` seam, Langfuse exporter (self-host compose) + JSON/CLI fallback | reviewer sees a turn's full timeline in Langfuse (or CLI) in <1 min |
| **6. Evals** | datasets (20–30/behavior), runners, per-provider report, latency bench | `npm run eval` prints table + failures across 3 providers |
| **7. Sandbox** | HighLevel OAuth, real Conversations/Contacts/Calendars, webhook registration, `SETUP.md` | real message round-trips in sandbox |
| **8. Docs & demo** | README (architecture, trade-offs, Team-of-One), eval table, functional-vs-mocked, demo script | all deliverables present |

**Mock-first:** Phases 0–6 run entirely against `MockCrmClient` + a fixed KB, so everything is
testable/reproducible offline (except live LLM calls). Phase 7 swaps in the real sandbox via config.

## 6. Open trade-offs to revisit

- Tool-based RAG trigger (one extra round-trip on retrieve) vs. a cheap classifier pre-gate.
- Flat in-memory index (default, chosen for 10–20 docs) vs. pgvector for scale-up.
- `LLMProvider` seam over the Vercel AI SDK (chosen — delegates wire-normalization) vs. hand-rolled
  per-SDK adapters (more control, more code).
- Serialize-per-conversation vs. debounce/coalesce for rapid messages.
- LLM-judge groundedness vs. deterministic fact checks in evals.
- Langfuse as primary trace UI (opt-in via env; self-host or cloud) vs. the always-on JSON/CLI
  fallback — we keep both so the harness stays inspectable with zero external infra.
- Streaming is normalized in the provider layer but the CRM send is a single final message; streaming
  mainly reduces internal time-to-first-token. Documented, not user-facing.
