# Production Hardening & Observability Plan

Status: workstreams 1–4 **implemented + tested**; workstream 5 (Langfuse) **config
ready**, deploy is manual (needs an interactive Fly login). This is the
source-of-truth for the robustness work agreed after the pgvector/Fly decision. It
also records what we deliberately defer for the POC/demo and why.

Context: the harness is webhook-driven (HighLevel "Customer Replied" → `/webhook` →
orchestrator → LLM + skills + RAG → reply). Persistence is Postgres/pgvector
(KB + webhook idempotency); HighLevel remains system-of-record for contacts and
conversation messages. See `ARCHITECTURE.md` for the base design.

---

## Decisions locked in

- **Database:** use Fly's provided Postgres for the POC (not a managed PG migration).
  Cost/ops trade-off accepted; see "Known limitations". NOTE: Fly's unmanaged Postgres
  image does NOT ship the `vector` extension, so on Fly the **KB stays on the baked
  file index** (great for our ~94 chunks) while **idempotency uses Postgres**. The
  pgvector KB is opt-in via `PGVECTOR=true` and needs a pgvector-capable Postgres
  (or Fly Managed Postgres). Deployed live at `conversation-ai-harness.fly.dev`.
- **Conversation history:** already implemented — each turn sends the **last 40
  user/assistant messages** (`ConversationStore` → `Orchestrator`) so ongoing-
  conversation relevance is preserved. Restart re-hydration from HighLevel is a
  documented limitation, not built now.
- **PII masking placement:** mask at the **observability sinks (logs + traces)**,
  NOT at the LLM boundary — the agent needs name/email/budget to drive the skills.
- **Scale:** single always-warm instance for the POC. Horizontal scaling is out of
  scope (see "Known limitations" for the reason it isn't a drop-in).
- **Langfuse:** self-host **v2** (light: 1 container + shared Postgres) rather than
  the v3 six-container stack. Confirmed.

---

## Workstreams

### 1. Webhook authenticity  ✅
**Why:** `/webhook` is currently open — anyone who learns the URL can inject a fake
customer message. `HL_WEBHOOK_SECRET` exists in env but is not enforced.

**Plan:** verify a shared-secret header on every inbound; reject with `401` on
missing/mismatch; skip the check when the secret is unset (local dev). If HighLevel
can sign, prefer HMAC-SHA256 over the raw body + a freshness/timestamp check for
replay protection.

**Touches:** `src/server/app.ts`, `src/server/webhook.ts`.
**Done when:** test — no/wrong secret → 401; correct secret → processes.

### 2. Crash-safe idempotency + booking exactly-once  ✅
**Why:** today the webhook acks then processes on an in-memory queue
(fire-and-forget). A crash mid-turn loses the message AND leaves the idempotency key
set, so HighLevel's retry is dropped as a "duplicate" → the customer is never
answered. Worse, a turn that books then crashes before completing could double-book
on retry.

**Plan:**
- (a) **Processing lease** on `processed_messages`: claim as `processing` on arrival,
  mark `done` only on success; a `processing` row older than a short lease is
  reclaimable, so a crash-mid-turn is re-driven instead of silently dropped.
- (b) **Idempotent booking:** before `createAppointment`, check for an existing
  appointment for the same contact + slot (or pass a dedupe key), so a re-drive can't
  create a second one.

**Touches:** `src/orchestrator/pg-idempotency.ts`, `src/orchestrator/idempotency.ts`,
`db/schema.sql`, `src/skills/appointment.skill.ts`, `src/server/app.ts`.
**Done when:** tests — replayed booking → single appointment; a stale `processing`
lease is reclaimed and reprocessed.
**Scope note:** the lease is the meatier part; the booking-guard + release-on-failure
alone is the lighter option if we choose to defer the lease.

### 3. PII masking at logs + traces  ✅
**Why:** logs and — more importantly — **traces** (Langfuse + JSON exporters) carry
the full assembled prompt incl. contact PII (name/email/budget) and conversation
history, with no redaction or retention limit.

**Plan (two-layer, adapted from a pattern used elsewhere):**
- Shared `redactPii(text)` util: **RE2-safe (non-backtracking)** email + phone
  masking that keeps first char + domain (`ja***@gmail.com`) so logs stay useful for
  correlation, with a length guard on the hot path.
- **Logs:** pino `redact.paths` for known secret/PII keys (Authorization, HL tokens,
  `*.email`, contact-field values) → `***MASKED***`, plus a `logMethod` hook running
  `redactPii` over free-text message args (paths can't reach interpolated PII).
- **Traces:** scrub `input` / `reply` / `system` / tool inputs+outputs in the trace
  collector before export (Langfuse + JSON).
- **LLM input is intentionally NOT masked** — the skills need the real values.
- Add a trace/log **retention** note (TTL) for the sink.

**Touches:** new `src/util/redact.ts`, `src/util/logger.ts`, `src/trace/collector.ts`
(or the exporters).
**Done when:** tests — email/phone masked in a log line and in the trace JSON; the
update-contact skill still receives real values.

### 4. Docs: "Production hardening / known limitations"  ✅
**Why:** the assignment asks for an honest "functional vs. mocked" account.

**Plan:** a README section summarizing what's hardened (webhook auth, exactly-once,
PII masking, self-hosted tracing) vs. what's deferred (single-instance POC, restart
re-hydration, Tier-2 items below). Link to this doc.

**Touches:** `README.md`.

### 5. Self-host Langfuse v2 on Fly + connect  🟡 config ready
**Why:** own the trace data end-to-end; no external SaaS dependency for the demo.

**Footprint:** v2 = **1 container (`langfuse/langfuse:2`) + Postgres**. (v3 would be 6
containers — web, worker, Postgres, ClickHouse, Redis, MinIO — min 4 vCPU / 8 GB;
deferred as overkill for the POC.) Our `LangfuseExporter` is already wired and
auto-enables when the three keys are present — **no harness code change**; "connect"
is just secrets.

**Plan:**
1. `deploy/langfuse/fly.toml` — a second Fly app running `langfuse/langfuse:2`
   (~1 GB machine).
2. `fly postgres attach` the **same** Postgres cluster → Langfuse gets its own
   database + `DATABASE_URL`.
3. Set Langfuse secrets: `NEXTAUTH_URL` (its Fly URL), `NEXTAUTH_SECRET`, `SALT`,
   `ENCRYPTION_KEY`; then `fly deploy`.
4. In the Langfuse UI → create org/project → copy `pk-lf-…` / `sk-lf-…`.
5. On the **harness** app:
   `fly secrets set LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… LANGFUSE_BASEURL=https://<langfuse-app>.fly.dev`
   → traces begin flowing.

**Touches (repo):** new `deploy/langfuse/fly.toml`, `docs/SETUP.md` (exact commands).
The `fly deploy` steps are run manually (they need an interactive Fly login).
**Done when:** a live turn's trace (prompt, model, RAG chunks+scores, skills, latency)
appears in the self-hosted Langfuse UI.

---

## Ordering

Code + docs first (#1 → #2 → #3 → #4), then prep the Langfuse config (#5) so it's
ready to deploy. Each change lands behind existing seams; the DB-less/no-Langfuse
default keeps working throughout.

---

## Deferred (POC scope — captured, not built)

These are real production needs, intentionally out of scope for the demo:

- **Managed Postgres** (backups/PITR/HA). Fly's own docs note the built-in Postgres is
  "not managed" — only 5-day local snapshots. Using it knowingly for the POC.
- **Horizontal scaling.** pg-idempotency allows >1 instance, but the in-memory
  `KeyedQueue` + history cache are per-instance — the same conversation on two
  machines would run concurrently and break per-conversation serialization. Needs
  conversation-affinity routing or a distributed lock before scaling out.
- **Restart re-hydration** of history from HighLevel's Conversations API (cache-miss
  fetch). Today a restart drops mid-conversation in-memory context.
- **Timeouts + retry budgets + provider failover** on LLM/HL/embedding calls
  (a hung provider currently wedges that conversation via the serialized queue).
- **Metrics + SLO alerting** (p50 ≤ 3s / p95 ≤ 6s targets), token-cost tracking.
- **RAG maturity:** hybrid search (vector + BM25) + reranking, HNSW tuning, halfvec
  quantization — only once the KB grows well past the current ~94 chunks.
- **CI eval gate** (run the eval suite as a deploy gate), canary + rollback.
- **Versioned migrations** (e.g. node-pg-migrate) once the schema evolves past the
  single idempotent `db/schema.sql`.

---

## References

- Fly: [This Is Not Managed Postgres](https://fly.io/docs/postgres/getting-started/what-you-should-know/) ·
  [Managed Postgres](https://fly.io/docs/mpg/)
- Webhooks: [security patterns](https://didit.me/blog/webhook-security-patterns/) ·
  [signing & HMAC](https://hooque.io/guides/webhook-security/)
- Durable execution for agents: [Inngest](https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents) ·
  [Zylos](https://zylos.ai/research/2026-04-24-durable-execution-agent-runtimes/)
- pgvector at scale: [ClickHouse](https://clickhouse.com/resources/engineering/scale-vector-search-postgres) ·
  [Markaicode](https://markaicode.com/pgvector-rag-production/)
- Langfuse self-hosting: [overview](https://langfuse.com/self-hosting) ·
  [v2 (light)](https://langfuse.com/self-hosting/v2) ·
  [ClickHouse infra (v3)](https://langfuse.com/self-hosting/deployment/infrastructure/clickhouse)
