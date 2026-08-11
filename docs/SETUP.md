# HighLevel Sandbox Setup

What to create in HighLevel and the values to drop into `.env` so the harness can run end-to-end.
Auth path: **Marketplace app + OAuth**. The harness is built mock-first (Phases 0–6 need none of
this); this is the Phase 7 wiring checklist.

## 1. Accounts
1. Create a **HighLevel developer/agency account** and a **sub-account (Location)** to test in.
2. Note the **Location ID** → `HL_LOCATION_ID`.

## Auth: pick one

**Option A — Private Integration Token (simplest, recommended for the demo).** No OAuth flow.
1. In the sub-account: **Settings → Private Integrations → Create new integration**.
2. Select scopes (Conversations read/write + messages, Contacts read/write, Calendars read + events
   read/write, Users read, Custom Fields read).
3. Copy the generated token → `.env` as `HL_PRIVATE_TOKEN=...`. Done — the harness uses it directly.
4. **Inbound messages** then come via a **Workflow** (not an app webhook): sub-account → **Automation
   → Workflows → Create** → trigger **"Customer Replied"** (or Inbound Message) → add a **Webhook**
   action → POST to `<ngrok-url>/webhook`. Publish it.

**Option B — Marketplace app + OAuth (full production pattern).** Steps 2–3 below. Use the app's
**Install link** (not a hand-built URL) to authorize, then the app's `InboundMessage` webhook.

Either way you still need the sub-account objects in §5.

## 2. Marketplace app (OAuth)
In the Marketplace developer portal, **create an app**, then open **Advanced Settings → Auth** (this
is the page that has the Install link, Redirect URLs, and Scopes). *Note:* "External Authentication"
is a different feature (for apps with their own login) — leave it **off**.
1. Copy **Client ID** / **Client Secret** → `HL_CLIENT_ID`, `HL_CLIENT_SECRET`.
2. Under **Redirect URLs**, add your callback → also set it as `HL_REDIRECT_URI`
   (local: `http://localhost:3000/oauth/callback`; deployed: `https://<app>.fly.dev/oauth/callback`).
3. Select the **scopes**:
   - `conversations.readonly`, `conversations.write`, `conversations/message.readonly`, `conversations/message.write`, `conversations/livechat.write`
   - `contacts.readonly`, `contacts.write`
   - `locations/customFields.readonly`
   - `calendars.readonly`, `calendars/events.readonly`, `calendars/events.write`
   - `users.readonly`
4. **Authorize:** use the app's **Install link** on that same page (it *is* the authorize URL — don't
   hand-build one) → choose **Sub-Account View** → pick your sub-account → Install. HighLevel redirects
   to your callback with a `?code=…`; the harness exchanges it and stores the **location access +
   refresh token** (auto-refreshed). On Fly the token is persisted in **Postgres, encrypted at rest**
   (AES-256-GCM via `TOKEN_ENCRYPTION_KEY`) so it survives deploys; locally it's a `0600` file.
   - ⚠️ OAuth and PIT are mutually exclusive: unset `HL_PRIVATE_TOKEN` for the OAuth callback to run.
   - A **draft** app is fine for OAuth — no publishing needed.

## 3. Inbound webhook (native `InboundMessage` — free)
The app's **native `InboundMessage` webhook** is the production path: it's **free** (unlike the
Premium "Custom Webhook" *workflow action*), delivers even on a **draft** app once installed, and is
**Ed25519-signed** rather than secret-header'd.
1. In the app: **Advanced Settings → Webhooks** → set the **Webhook URL** to `…/webhook`
   (deployed: `https://<app>.fly.dev/webhook`; local dev: an `ngrok http 3000` HTTPS URL) → enable the
   **`InboundMessage`** event → Save.
2. **Authenticity:** HighLevel signs each delivery with **`x-ghl-signature`** (Ed25519). Our `/webhook`
   verifies it against HighLevel's published public key — **no per-app secret needed** for native
   webhooks (see `src/server/hl-signature.ts`).
3. `HL_WEBHOOK_SECRET` is only for **our own** posts (a HighLevel *workflow* "Send Webhook" action, or
   local `curl` tests): send it as `x-webhook-secret`. `/webhook` accepts **either** a valid signature
   **or** the shared secret.

> Alternative (no app): a **workflow** "Customer Replied → Send Webhook" action can POST to `/webhook`
> with an `x-webhook-secret` header — but the *Custom Webhook* action is a **billed Premium** action
> (a drained wallet silently skips it). The native `InboundMessage` webhook above avoids that.

## 4. Channel (decide at Phase 7)
Sending a reply needs a live channel in the sub-account — **either** provision a **LeadConnector phone
number** (SMS) **or** configure **email sending**. Pick when we wire the send path.

## 5. Objects the skills reference
1. **Custom fields** on the contact for the Update-Contact-Field skill — create **budget** and
   **preferred time** (name/email/phone are standard). Copy their field IDs →
   `HL_FIELD_BUDGET_ID`, `HL_FIELD_PREFERRED_TIME_ID`. (The harness can also resolve these by name
   via the custom-fields API.)
2. **Calendar** — create one with availability + an assigned team member. Copy the calendar id →
   `HL_CALENDAR_ID`, and that team member's **user id** → `HL_CALENDAR_USER_ID` (HighLevel requires
   an assignee to create an appointment).
3. **Handover markers** — a tag (e.g. `bot-handover`) → `HL_HANDOVER_TAG`, and/or a user to reassign
   the conversation to → `HL_HANDOVER_USER_ID`.
4. Create a couple of **test contacts** to converse with.

## 6. `.env`
Copy `.env.example` → `.env` and fill in the values above. API base + version header are set in code
(`https://services.leadconnectorhq.com`).

---

## 7. Deploy to Fly (Managed Postgres + pgvector)

The harness runs on Postgres both locally and on Fly. Use **Fly Managed Postgres (MPG)** — it ships
the `vector` extension, so the KB lives in pgvector in production (with `PGVECTOR=true` in `fly.toml`)
and idempotency is Postgres-backed. `fly.toml` keeps one warm machine; the deploy `release_command`
runs `migrate` (schema + HNSW index) then `ingest-pg` (embeds the KB into Postgres — no `kb.json`).

> Why MPG and not `fly postgres create`? Fly's self-hosted **Postgres-Flex** image does **not** bundle
> pgvector (`vector` isn't in `pg_available_extensions` and there's no `vector.so`), and you can't
> durably install it. MPG offers `vector` as a first-class extension.

```sh
flyctl auth login                              # interactive
fly launch --no-deploy                         # create the app from fly.toml
fly mpg create --org <org> --name <cluster> \
  --region sin --plan development --pg-major-version 17   # provision Managed Postgres
# → Enable pgvector: Fly dashboard → cluster → Extensions → toggle `vector` ON (schema: public).
#   The app role isn't superuser, so CREATE EXTENSION is a management-plane action.
fly mpg attach <cluster-id> -a <app>           # sets the DATABASE_URL secret (pgbouncer pooler)
fly secrets set -a <app> \
  LLM_PROVIDER=openai OPENAI_API_KEY=… OPENAI_BASE_URL=https://api.groq.com/openai/v1 \
  OPENAI_MODEL=openai/gpt-oss-120b HL_PRIVATE_TOKEN=… HL_LOCATION_ID=… HL_CALENDAR_ID=… \
  HL_CALENDAR_USER_ID=… HL_HANDOVER_USER_ID=… HL_FIELD_BUDGET_ID=… HL_FIELD_PREFERRED_TIME_ID=… \
  HL_WEBHOOK_SECRET=$(openssl rand -hex 24)     # then send this secret as the webhook's x-webhook-secret header
fly deploy                                     # builds, runs migrate + ingest-pg, ships
```

`fly.toml` sets `PGVECTOR = "true"`. `db/schema-pgvector.sql` guards `CREATE EXTENSION` in a
`DO/EXCEPTION` block so the non-superuser migration succeeds when `vector` is already enabled on MPG.

A stable `https://<app>.fly.dev` URL replaces ngrok — point the HighLevel workflow webhook at
`…/webhook` once (add header `x-webhook-secret: <the secret above>`).

> **Re-attaching MPG when `DATABASE_URL` already exists:** `fly secrets unset DATABASE_URL -a <app>
> --stage` first, then `fly mpg attach`. If migrating off an old flex cluster, destroy it afterwards
> (`fly postgres destroy <old-pg>`) so it stops billing — the KB is re-ingested from source on deploy
> and idempotency data is ephemeral, so nothing is lost.

## 8. Self-hosted Langfuse (tracing)

Light **v2** footprint: one container + a database on the *same* Postgres cluster. Config lives in
`deploy/langfuse/fly.toml` (full commands are in its header comment). Summary:

```sh
fly apps create conversation-ai-langfuse
fly postgres attach <pg-app> -a conversation-ai-langfuse          # its own DB + DATABASE_URL
fly secrets set -a conversation-ai-langfuse \
  NEXTAUTH_URL=https://conversation-ai-langfuse.fly.dev \
  NEXTAUTH_SECRET=$(openssl rand -hex 32) SALT=$(openssl rand -hex 16) \
  ENCRYPTION_KEY=$(openssl rand -hex 32)
fly deploy --config deploy/langfuse/fly.toml -a conversation-ai-langfuse
```

Then create a project in the Langfuse UI, copy the keys, and connect the harness (no code change —
the exporter auto-enables):

```sh
fly secrets set -a conversation-ai-harness \
  LANGFUSE_PUBLIC_KEY=pk-lf-… LANGFUSE_SECRET_KEY=sk-lf-… \
  LANGFUSE_BASEURL=https://conversation-ai-langfuse.fly.dev
```

## 9. Local dev on Postgres + pgvector (no JSON index)

Run the KB **and** idempotency in Postgres locally — the production-shaped path, no `kb.json`.
DB access is **Drizzle ORM** (`src/config/schema.ts`); the pgvector `CREATE EXTENSION` + HNSW DDL is
applied from `db/*.sql` by `pnpm db:migrate` (Drizzle can't express extensions). Needs local Postgres
with the **pgvector** extension (Homebrew PG works):

```sh
brew install pgvector                                   # adds the extension to your local PG
createdb conversation_ai
psql conversation_ai -c 'CREATE EXTENSION vector;'

# .env:
#   DATABASE_URL=postgres://localhost:5432/conversation_ai
#   PGVECTOR=true

pnpm db:migrate     # core (processed_messages) + pgvector (kb_chunks) schema
pnpm ingest:pg      # embeds the KB DIRECTLY into Postgres (no kb.json) — OKF provenance included
pnpm dev            # retrieval hits pgvector; idempotency is Postgres-backed
```

Inspect the OKF provenance that ingestion stored:
```sh
psql conversation_ai -c \
  "SELECT doc_id, status, verified_by, stale_after, source_id FROM kb_chunks LIMIT 8;"
pnpm db:studio      # or browse the DB in Drizzle Studio
```

> Without `DATABASE_URL` the harness uses the in-memory idempotency store + the baked file index —
> that's the zero-setup default and what runs on Fly (whose managed Postgres lacks pgvector).
