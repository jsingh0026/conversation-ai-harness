# Architecture & Build Plan

> Design doc for the Conversation AI Agent Harness. Read alongside [`ASSIGNMENT.md`](./ASSIGNMENT.md).
> **Status: proposed — pending review before implementation.**

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
                                        └──▶ Trace collector ──▶ JSON + CLI viewer
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

### 3.2 Provider abstraction

```ts
interface LLMProvider {
  readonly name: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<StreamChunk>;
}

interface GenerateRequest {
  system: string;
  messages: Message[];            // canonical role/content, incl. tool results
  tools?: ToolSpec[];             // canonical JSON-schema tool defs
  toolChoice?: 'auto' | 'required' | 'none';
  model: string; temperature?: number; maxTokens?: number;
}

interface GenerateResult {
  text: string | null;
  toolCalls: ToolCall[];          // {id, name, args} — normalized across providers
  usage: { inputTokens: number; outputTokens: number };
  finishReason: 'stop' | 'tool_use' | 'length' | 'error';
  raw: unknown;                   // provider-native response, for the trace
}
```

Each adapter (`claude.ts`, `openai.ts`, `gemini.ts`) translates canonical `ToolSpec` → its native
format (Anthropic `tools`, OpenAI `functions`, Gemini `functionDeclarations`) and normalizes the
response back to `ToolCall[]`. Errors map to typed classes (`RateLimitError`, `AuthError`,
`ContextLengthError`, `TransientError`) so retry/backoff is uniform. Selection is config:
`LLM_PROVIDER=claude|openai|gemini` + per-provider model in config — **switching is a config change,
not a code change.** Embeddings are a *separate* `Embedder` interface (chat provider ≠ embed provider).

### 3.3 Skills framework

```ts
interface Skill<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;   // shown to the LLM for selection
  readonly parameters: JSONSchema; // tool input schema (validated before execute)
  execute(input: I, ctx: SkillContext): Promise<SkillResult<O>>;
}
```

Skills self-register into a `SkillRegistry`; the registry is what the orchestrator exposes to the LLM
as tools. **Adding a skill = implement the interface + register it. No core edits.** `SkillContext`
gives a skill the `CrmClient`, contact/conversation, and the trace collector.

### 3.4 CRM client (mockable)

A single `CrmClient` interface wraps HighLevel: `sendMessage`, `getContact`, `updateContact`,
`addTag`, `assignOwner`, `getFreeSlots`, `createAppointment`, plus bot on/off state. Two
implementations: `HighLevelClient` (real sandbox, OAuth) and `MockCrmClient` (in-memory, deterministic).
We build and eval against the mock, then swap to real via config — no orchestrator changes.

### 3.5 RAG pipeline

- **KB:** 10–20 markdown docs for a fictional business (proposed: **a real-estate brokerage** — fits
  the `budget` / `preferred time` contact fields, appointment booking, and a rich FAQ KB).
- **Ingest (`npm run ingest`):** load docs → chunk (heading-aware, ~500 tokens, overlap) → embed →
  persist a local index (SQLite via `sqlite-vec`, or a flat JSON loaded into memory — both fully
  local, zero infra). Loaded into memory at boot for sub-ms cosine search.
- **Retrieve:** embed query → top-k cosine → **score threshold**. If best score < threshold →
  "no grounded answer" signal → model declines or hands over. System prompt enforces *answer only
  from retrieved context*.

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

Emitted as structured JSON (file + stdout) with a small CLI pretty-printer (`npm run trace <id>`) and
a `GET /traces/:id` route. Goal: answer "why did it say that?" in under a minute.

## 4. Module layout

```
src/
  config/         env schema (zod) + provider/model config + feature flags
  server/         fastify app, webhook route, health, /traces/:id
  orchestrator/   turn loop, decision, idempotency store, per-convo queue
  providers/      LLMProvider + claude/openai/gemini adapters + registry + tool translation
  llm/            canonical types (Message, ToolSpec, ToolCall, usage), typed errors, retry
  rag/            Embedder, chunker, vector store, retriever, ingest script
  skills/         Skill interface + registry + updateContact / handover / appointment
  crm/            CrmClient interface + HighLevelClient + MockCrmClient
  trace/          Trace types, collector, emitter, pretty-printer
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
| **5. Trace polish** | full per-step trace, `/traces/:id`, CLI viewer | "why did it say that" answerable in <1 min |
| **6. Evals** | datasets (20–30/behavior), runners, per-provider report, latency bench | `npm run eval` prints table + failures across 3 providers |
| **7. Sandbox** | HighLevel OAuth, real Conversations/Contacts/Calendars, webhook registration, `SETUP.md` | real message round-trips in sandbox |
| **8. Docs & demo** | README (architecture, trade-offs, Team-of-One), eval table, functional-vs-mocked, demo script | all deliverables present |

**Mock-first:** Phases 0–6 run entirely against `MockCrmClient` + a fixed KB, so everything is
testable/reproducible offline (except live LLM calls). Phase 7 swaps in the real sandbox via config.

## 6. Open trade-offs to revisit

- Tool-based RAG trigger (one extra round-trip on retrieve) vs. a cheap classifier pre-gate.
- SQLite (`sqlite-vec`) vs. flat in-memory JSON for the vector index.
- Serialize-per-conversation vs. debounce/coalesce for rapid messages.
- LLM-judge groundedness vs. deterministic fact checks in evals.
- Streaming is normalized in the provider layer but the CRM send is a single final message; streaming
  mainly reduces internal time-to-first-token. Documented, not user-facing.
