# Conversation AI Agent Harness

An agent harness that powers a [HighLevel](https://www.gohighlevel.com/) Conversation AI agent
end-to-end: it receives an inbound customer message, decides what to do (answer from a knowledge
base, run a skill, or hand over to a human), executes it, and replies back into the CRM
conversation — with a full, inspectable trace of every step.

Built for a fictional real-estate brokerage, **Lumina Realty**.

> 📐 Architecture & design rationale: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) ·
> 🔌 Sandbox setup: [`docs/SETUP.md`](./docs/SETUP.md) ·
> 🎬 Demo script: [`docs/DEMO.md`](./docs/DEMO.md) ·
> 📄 Assignment: [`docs/ASSIGNMENT.md`](./docs/ASSIGNMENT.md)

## What it does

- **Multi-provider LLM** — Claude, OpenAI, and Gemini behind one `LLMProvider` seam (over the
  Vercel AI SDK). Switching provider is a config change (`LLM_PROVIDER=claude|openai|gemini`).
- **RAG-triggered knowledge base** — retrieval is a *tool the agent chooses to call*, so chit-chat
  and skill-only turns never hit the vector store. A similarity threshold yields an explicit
  "no answer" so the agent declines instead of inventing.
- **Extensible skills** — Update Contact Field, Human Handover, Appointment Booking. Adding a skill
  is one file + one array entry; its Zod schema is surfaced to the model and validated.
- **Execution transparency** — every turn emits a `Trace`: assembled prompt, provider/model,
  RAG chunks + scores, each tool's I/O + CRM calls, tokens, and per-step latency. View it in
  **Langfuse** (opt-in) or the built-in **CLI viewer**.
- **Evals** — one command benchmarks RAG-trigger precision/recall, groundedness, every skill
  (including negatives that must NOT fire), and per-provider latency, over 116 gold-labeled cases.

## The orchestration loop

```
Inbound webhook → normalize → idempotency dedupe → per-conversation queue → ack fast
                                                          │
                          ┌───────────────────────────────┘
                          ▼  Orchestrator.runTurn  (bounded tool-use loop)
   bot disabled? ──yes──▶ stay silent (already handed over)
        │no
        ▼
   system prompt + history + user msg ──▶ provider.generate(tools)
        ├─ no tool call   → reply directly (chit-chat)
        ├─ search_kb      → retrieve (threshold) → grounded answer / decline
        ├─ a skill        → execute, feed result back, loop
        └─ handover       → stop bot, tag/reassign, send final message
        ▼
   send reply into CRM ──▶ emit Trace (Langfuse / JSON / CLI)
```

## Quickstart

Prereqs: **Node ≥ 20**, **pnpm**. (Built on Node 22 + pnpm 10.)

```bash
pnpm install
cp .env.example .env          # then fill in keys (see below)

# Build the KB vector index (needs an embedding key)
pnpm ingest

# Run the server (webhook on :3000)
pnpm dev

# In another shell, simulate an inbound message:
curl -sX POST localhost:3000/webhook -H 'content-type: application/json' \
  -d '{"messageId":"m1","conversationId":"c1","contactId":"ct1","body":"What is your commission?","messageType":"SMS"}'

# Inspect what happened:
pnpm trace latest
```

### Minimum `.env` to run against mocks (no sandbox needed)

```
LLM_PROVIDER=claude
ANTHROPIC_API_KEY=sk-ant-...        # a key for whichever LLM_PROVIDER you pick
EMBED_LOCAL=true                    # embeddings run on-device — no embedding key needed
CRM_MODE=mock
```

**Embeddings, local or cloud.** `EMBED_LOCAL=true` runs a Transformers.js model
(`Xenova/bge-small-en-v1.5`, 384-dim) fully on-device — the model downloads once (~130 MB) then
needs no network or API key. Set `EMBED_LOCAL=false` to use a cloud embedder instead
(`EMBED_PROVIDER=openai|gemini` + `EMBED_MODEL`, which then needs that provider's key). The chat
LLM key is still required either way.

`CRM_MODE=mock` runs the whole loop against an in-memory CRM — no HighLevel account required.
To connect the real sandbox, set `CRM_MODE=highlevel` and follow [`docs/SETUP.md`](./docs/SETUP.md).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run the webhook server (hot reload) |
| `pnpm ingest` | Chunk + embed `kb/*.md` → `data/index/kb.json` |
| `pnpm eval [provider...] [suite...]` | Run the eval suite (see below) |
| `pnpm trace [<id>\|latest]` | Terminal trace viewer |
| `pnpm providers:smoke [provider]` | Sanity-check a provider returns a tool call |
| `pnpm test` · `pnpm typecheck` · `pnpm lint` | 121 tests · types · lint |

## Multi-provider

One `AiSdkProvider` implements the `LLMProvider` interface for all three providers — same code, a
different AI SDK model handle. Adding a fourth is a new case in `src/providers/registry.ts` + a model
handle. Errors are normalized to typed classes (`RateLimitError`, `AuthError`, `ContextLengthError`,
`TransientError`) so retry/backoff is uniform. Provider switch = `LLM_PROVIDER` env.

## Tracing

Every turn produces a `Trace` (the canonical record), fanned out to pluggable exporters:

- **Langfuse** (opt-in via `LANGFUSE_*` keys) — turn → trace, LLM call → generation, retrieval/tool
  → span. Self-host with `docker compose up` or use Langfuse Cloud.
- **JSON files** (`traces/*.json`) + a **CLI viewer** (`pnpm trace`) — always on, zero infra.

The CLI viewer shows the prompt, each provider/tool step with tokens + latency, RAG chunks with
scores, the decision, and the reply — enough to answer *"why did the agent say that?"* in seconds.

## Evals

```bash
pnpm eval                     # all providers with a key, all suites
pnpm eval claude              # one provider
pnpm eval openai handover latency   # provider(s) + suite filter
```

Runs real turns per provider and scores the trace against 116 gold-labeled cases:

| Suite | Cases | Measures |
|---|---|---|
| `rag-trigger` | 26 | precision/recall of *deciding to retrieve* (chit-chat/skill turns must not) |
| `groundedness` | 24 | grounded answers contain the expected facts; out-of-KB questions are declined |
| `update-contact` | 22 | field extraction fires + extracts the right fields; negatives don't fire |
| `handover` | 22 | fires on explicit/frustrated/out-of-scope; negatives don't fire |
| `appointment` | 22 | booking intent triggers slot lookup; negatives don't fire |
| `latency` | 8 | p50 ≤ 3s / p95 ≤ 6s webhook-to-send (non-RAG) |

Grounded facts are matched with word/number boundaries (so `5%` ≠ `15%`); declines are checked
against a fabricated-figure denylist. Infra errors (e.g. a missing embedding key) are surfaced as
errors and fail the run — they never masquerade as model behavior. Exit code is non-zero on any
failure or error.

### Results

Run `pnpm eval` to populate this table (requires provider + embedding API keys):

| Provider | rag-trigger (P/R) | groundedness | update-contact | handover | appointment | latency p50/p95 |
|---|---|---|---|---|---|---|
| claude | _run to fill_ | | | | | |
| openai | | | | | | |
| gemini | | | | | | |

See [`docs/EVAL_RESULTS.md`](./docs/EVAL_RESULTS.md) for how to record results + a candid failure analysis.

## Repo layout

```
src/
  config/        env schema (zod)
  server/        Fastify app: /webhook, /health, OAuth routes
  orchestrator/  turn loop, idempotency, per-convo queue, history, tool dispatch
  providers/     LLMProvider over the Vercel AI SDK + registry
  llm/           canonical types, typed errors, retry
  rag/           chunker, embedder, vector store, retriever, ingest, search_kb tool
  skills/        registry + update-contact / handover / appointment
  crm/           CrmClient interface + MockCrmClient + highlevel/ (real client, OAuth)
  trace/         Trace types, collector, exporters (Langfuse / JSON / console), CLI
evals/           harness, runners, scoring, cases/*.json, report
kb/              13 markdown docs (Lumina Realty)
docs/            ARCHITECTURE, SETUP, DEMO, EVAL_RESULTS, ASSIGNMENT
```

## Team-of-One ownership

- **Product** — scoped to the four required capabilities and a coherent demo persona (a boutique
  brokerage) so every skill and KB doc reinforces one story; picked the fictional business to fit
  the required contact fields (budget, preferred time) and appointment booking.
- **Design** — the "seams" are the design: provider / skill / CRM / tracing are independent
  interfaces so the graders' "is a 4th provider or 3rd skill cheap?" question is a clear yes. The
  trace surface is designed around one question — *why did the agent say that?*
- **Engineering** — a bounded tool-use loop as the single decision mechanism; the Vercel AI SDK for
  normalized multi-provider calls; a flat in-memory vector index (zero infra for a small KB) behind
  a swappable interface; mock-first so everything runs offline.
- **QA** — 121 unit tests + an independent adversarial review sweep after every phase (findings
  applied before moving on), plus the eval suite as behavioral regression coverage.

## Functional vs. mocked

**Functional (tested):** the full orchestration loop, all three provider adapters, RAG ingest +
retrieval + threshold, all three skills, tracing (JSON/CLI + Langfuse mapping), the eval harness and
scoring, and the HighLevel client's request/response shapes (unit-tested with an injected `fetch`).

**Requires keys / a sandbox to exercise live:** actual LLM + embedding calls (need API keys), the
Langfuse dashboard (needs a Langfuse instance), and the real HighLevel round-trip (needs the sandbox
+ OAuth). The HighLevel client was built to the documented v2 API but validated against mocks, not a
live account — see [`docs/EVAL_RESULTS.md`](./docs/EVAL_RESULTS.md) and `docs/SETUP.md`.

**Deliberately simplified:** bot on/off state is process-local in the live client (production would
back it with a KV store / the CRM); webhook signature verification is stubbed pending the sandbox.
