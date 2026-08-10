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
1. In the Marketplace developer portal, **create an app**.
2. Copy **Client ID** / **Client Secret** → `HL_CLIENT_ID`, `HL_CLIENT_SECRET`.
3. Set the **Redirect URI** → `HL_REDIRECT_URI` (e.g. `http://localhost:3000/oauth/callback`).
4. Enable the **scopes**:
   - `conversations.readonly`, `conversations.write`, `conversations/message.readonly`, `conversations/message.write`
   - `contacts.readonly`, `contacts.write`
   - `locations/customFields.readonly`
   - `calendars.readonly`, `calendars/events.readonly`, `calendars/events.write`
   - `users.readonly`
5. Complete the OAuth consent for the sub-account; the harness exchanges the code and stores the
   **location access + refresh token** (auto-refreshed in code).

## 3. Inbound webhook
1. Expose the local server publicly for dev — **ngrok**: `ngrok http 3000` → gives an HTTPS URL.
2. Subscribe the app to the **`InboundMessage`** event, delivery URL = `<ngrok-url>/webhook`.
3. If the app provides a **webhook signing secret**, copy it → `HL_WEBHOOK_SECRET` (used to verify deliveries).

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

## 7. Deploy to Fly (Postgres + pgvector)

The harness runs DB-less locally; on Fly it uses Postgres for the KB (pgvector) and webhook
idempotency. `Dockerfile` bakes the KB index + embed model; `fly.toml` keeps one warm machine.

```sh
flyctl auth login                     # interactive
fly launch --no-deploy                # create the app from fly.toml
fly postgres create                   # provision Postgres
fly postgres attach <pg-app>          # sets DATABASE_URL secret
fly secrets set \
  LLM_PROVIDER=openai OPENAI_API_KEY=… OPENAI_BASE_URL=https://api.groq.com/openai/v1 \
  OPENAI_MODEL=openai/gpt-oss-120b HL_PRIVATE_TOKEN=… HL_LOCATION_ID=… HL_CALENDAR_ID=… \
  HL_CALENDAR_USER_ID=… HL_HANDOVER_USER_ID=… HL_FIELD_BUDGET_ID=… HL_FIELD_PREFERRED_TIME_ID=… \
  HL_WEBHOOK_SECRET=$(openssl rand -hex 24)     # then send this secret as the webhook's x-webhook-secret header
fly deploy                            # builds, runs migrate + ingest:pg, ships
```

A stable `https://<app>.fly.dev` URL replaces ngrok — point the HighLevel workflow webhook at
`…/webhook` once (add header `x-webhook-secret: <the secret above>`).

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
