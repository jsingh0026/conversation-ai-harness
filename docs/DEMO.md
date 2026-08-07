# Demo Script

A ~5-minute walkthrough hitting every item the assignment asks the demo to show. Record with Loom
(or similar). Run against the **real sandbox** (`CRM_MODE=highlevel`) so the CRM conversation is
visible; the trace pieces work identically in mock mode.

## Setup (before recording)

```bash
pnpm install && pnpm ingest
# .env: LLM_PROVIDER=claude, ANTHROPIC_API_KEY, OPENAI_API_KEY (embeddings),
#       CRM_MODE=highlevel + HL_* (see docs/SETUP.md), optional LANGFUSE_*
pnpm dev
# expose the webhook + point the app's InboundMessage webhook at it:
ngrok http 3000
```

Have two windows visible: the **CRM conversation** (HighLevel sub-account) and a **terminal** for
`pnpm trace`. If using Langfuse, have its UI open too.

## 1. Knowledge — a grounded answer

From the CRM, send as the customer: **"What's your commission to sell my house?"**
- The agent replies with the grounded fact (5% total, split 2.5% / 2.5%).
- `pnpm trace latest` → show the `retrieval` step: the query, the chunks pulled from
  `fees-and-commissions`, and their scores; then the final grounded reply.

## 2. Knowledge — a correct decline

Customer: **"What's the average home price in The Cove right now?"**
- The agent declines (that's live market data, not in the KB) rather than inventing a number.
- Trace: retrieval ran but returned nothing over the threshold (`grounded: false`) → the agent says
  it doesn't have that information.

## 3. Skill — update a contact field

Customer: **"I'm Jordan, my email is jordan@example.com and my budget is around $650k."**
- Trace: `tool: update_contact_field` fired with `{name, email, budget}`.
- Switch to the CRM contact record → show name, email, and the budget custom field now populated.

## 4. Skill — human handover (visible in the CRM)

Customer: **"This isn't helping, I want to talk to a real person."**
- The agent sends a brief final message and goes silent.
- CRM: show the conversation now tagged `bot-handover` (and reassigned if configured). Send another
  message as the customer and show the bot does **not** respond.

## 5. Trace — walk one execution end-to-end

`pnpm trace <turnId>` on the commission turn (or open it in Langfuse):
- assembled system prompt → provider/model + tokens → the `search_knowledge_base` decision →
  retrieved chunks + scores → the final grounded reply, with per-step latency. This is the
  "why did the agent say that?" answer in under a minute.

## 6. Provider switch (config, not code)

Stop the server, set `LLM_PROVIDER=openai` (or `gemini`) in `.env`, `pnpm dev`, and re-send the
commission question. Same behavior, different provider — show `/health` reporting the active
provider, and the new trace's `provider`/`model`.

## Optional — appointment booking

Customer: **"Can I tour a place tomorrow afternoon?"** → `get_available_slots` offers times →
customer picks one → `book_appointment` creates it (show it on the calendar). Mention the
slot-taken race is handled gracefully.
