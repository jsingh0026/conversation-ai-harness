# Chat Test Cases — manual QA script

Messages to type into the **Live Chat widget** (or send to `/webhook`) to exercise every
assignment requirement, with the expected behavior and where to verify it. Grouped by the
assignment's sections: **Core Functionality**, **Webhook Realities**, **Quality Bars**, **Deliverables**.

**How to run**
- **Widget path (real):** open the demo page, complete the contact form (Name + Phone), then type.
  The message flows widget → "Customer Replied" workflow → `/webhook` → harness → reply.
- **Direct path (precise control):** `POST https://conversation-ai-harness.fly.dev/webhook`
  with header `x-webhook-secret: <secret>` and body
  `{"messageType":"Live_Chat","contactId":"<id>","conversationId":"<id>","message":"<text>"}`.
- **Where to verify:**
  - **Reply** → in the chat / widget.
  - **Trace** → self-hosted Langfuse (`https://conversation-ai-langfuse.fly.dev`) or `pnpm trace latest`.
  - **CRM side effects** → the contact in HighLevel (fields, tags, appointment).

Legend: ✅ should happen · 🚫 should NOT happen (negative case).

---

## 1. Core Functionality

### 1a. Knowledge Base — grounded answers (RAG triggers, answer is grounded)

| # | Type in chat | Expected | Verify |
|---|---|---|---|
| 1 | What's your commission for sellers? | ✅ 5% of final price, split 2.5% / 2.5% | trace shows a `retrieval` step with chunks + scores |
| 2 | Do you help first-time buyers? | ✅ Demo First Key; up to **$2,500** closing-cost credit | grounded chunk `first-time-buyers` |
| 3 | What are your office hours? | ✅ Mon–Fri 9–6, Sat 10–4, closed Sunday | grounded |
| 4 | Tell me about the Dockside neighborhood | ✅ marina / lofts / rentals move fast | grounded chunk `neighborhoods` |
| 5 | How much do you charge to manage a rental? | ✅ 8% of monthly rent | grounded |
| 6 | *(paraphrase)* any help for folks buying their first place? | ✅ still grounds to first-time buyers / First Key | proves semantic match (wording differs from KB) |

### 1b. Knowledge Base — declines (out of KB / out of scope → never invents)

| # | Type in chat | Expected | Verify |
|---|---|---|---|
| 7 | What's the average home price in The Cove right now? | ✅ politely declines / offers a human — no invented figure | trace: retrieval below threshold → `grounded:false` |
| 8 | What are today's mortgage interest rates? | ✅ declines (not in KB) | no fabricated rate |
| 9 | Can you give me legal advice on my purchase contract? | ✅ declines / offers handover (out of scope) | may route to handover |
| 10 | What's the weather in Marisol Bay tomorrow? | ✅ declines — off-topic | no retrieval fabrication |

### 1c. RAG is *selective* (chit-chat / social → NO retrieval)

| # | Type in chat | Expected | Verify |
|---|---|---|---|
| 11 | hi there | ✅ friendly greeting | trace has **no** `retrieval` step |
| 12 | thanks, that's helpful! | ✅ warm acknowledgement | no retrieval |
| 13 | who are you? | ✅ "I'm Demo Realty's assistant…" | no retrieval |

### 1d. Skills

**Update Contact Field**

| # | Type in chat | Expected | Verify |
|---|---|---|---|
| 14 | I'm Alex Rivera, alex.rivera@example.com, my budget is about 550k | ✅ `update_contact_field` fires; confirms saved | CRM contact: name/email/budget set; trace tool I/O |
| 15 | Also I'd prefer to view on Saturday afternoon | ✅ saves preferred time | CRM custom field set |
| 16 | 🚫 What's your commission? | 🚫 does **not** call update_contact_field (no personal info shared) | trace: no tool step |

**Human Handover**

| # | Type in chat | Expected | Verify |
|---|---|---|---|
| 17 | I'd like to speak to a real human agent | ✅ handover: final message, bot stops, contact tagged `bot-handover` | CRM tag; trace decision `handover` |
| 18 | This bot is useless, get me a person | ✅ handover (frustration) | tag added |
| 19 | 🚫 Can you help me find a 3-bed near Old Town? | 🚫 does **not** hand over — this is in-scope | normal reply |

> After a handover, the bot stays silent for that conversation (durable via the tag). Use a **fresh
> contact** for later tests, or remove the `bot-handover` tag to re-enable.

**Appointment Booking**

| # | Type in chat | Expected | Verify |
|---|---|---|---|
| 20 | Can I book a viewing tomorrow afternoon? | ✅ `get_available_slots`; offers afternoon slots | trace tool `get_available_slots` |
| 21 | *(follow-up)* Yes, book the first one | ✅ `book_appointment`; confirms date/time | appointment created in the calendar |
| 22 | Any openings this weekend? | ✅ handles relative "this weekend" | slots filtered to Sat/Sun window |
| 23 | Can I come by Sunday? | ✅ no-availability handled gracefully (closed Sun) | "no open times… try another day?" |
| 24 | *(book same slot twice)* book the 2pm slot … book the 2pm slot | ✅ second call is idempotent — **no double booking** | only one appointment exists |
| 25 | 🚫 What times are you open? | 🚫 answers hours from KB — does **not** call the calendar | RAG, not slot lookup |

### 1e. Execution Transparency (every turn is inspectable)

| # | Action | Expected in the trace |
|---|---|---|
| 26 | Open any turn above in Langfuse / `pnpm trace` | ✅ assembled system prompt, provider + model, RAG chunks + scores (or none), each tool's input/output, tokens, per-step latency |
| 27 | Switch provider (`LLM_PROVIDER=openai→claude`) and re-ask #1 | ✅ same grounded answer, trace shows the new provider/model (proves multi-provider) |

### 1f. Conversation continuity + idle reset

| # | Type in chat | Expected |
|---|---|---|
| 28 | I'm mostly looking in Maple Heights → *(then)* what's the commission there? | ✅ uses prior context (last 40 msgs) — knows "there" = selling in Maple Heights |
| 29 | *(refresh the page, keep chatting within a few minutes)* | ✅ context kept (refresh is incidental) |
| 30 | *(return after 30+ min idle and start a new chat)* | ✅ context reset — fresh conversation (`HISTORY_IDLE_RESET_MIN`) |

---

## 2. Webhook Realities

*"Handle duplicate deliveries (idempotency) and rapid back-to-back customer messages."*

| # | Action | Expected | Verify |
|---|---|---|---|
| 31 | **Duplicate delivery** — send the *same* message twice within ~10s (widget: send identical text twice; direct: POST the same body twice) | ✅ processed **once**; the duplicate is dropped | 2nd POST returns `{"duplicate":true}`; only one reply + one trace |
| 32 | **Exact retry** — POST the same `messageId` twice | ✅ dropped as duplicate | idempotency store (Postgres `processed_messages`) |
| 33 | **Rapid back-to-back** — send 3 different messages in quick succession | ✅ all answered, **in order**, no interleaving/races | per-conversation `KeyedQueue` serializes; each gets its own reply |
| 34 | **Crash-safety** *(direct/dev)* — kill the process mid-turn, let HighLevel/redelivery resend | ✅ the message is **reclaimed and reprocessed** (not lost) | `processing → done` lease; log "key released for retry" |

> Note: the harness synthesizes a stable `messageId` from `contactId + body + 10s bucket` when the
> payload has none — so identical text within the same 10s window dedupes; a genuine repeat later goes through.

---

## 3. Quality Bars

### Latency — target p50 ≤ 3s / p95 ≤ 6s (webhook → send, non-RAG turns)

| # | Action | Expected | Verify |
|---|---|---|---|
| 35 | Send ~10 non-RAG turns (e.g., greetings / short chit-chat) | ✅ p50 ≤ 3s, p95 ≤ 6s | each trace's `latencyMs`; a clean deployed turn measured ~2.5s |
| 36 | Send a RAG turn (#1) | ✅ slightly higher (extra model hop for retrieval), still reasonable | `latencyMs` incl. retrieval step |

### Evals — one command, negatives included, per provider

```bash
pnpm eval                      # all providers with a key, all suites
pnpm eval openai handover      # filter provider + suite
```
Covers RAG-trigger precision/recall, groundedness, all three skills (incl. must-NOT-fire negatives),
and latency — 116 gold cases + latency, scored against each trace. Exit non-zero on any failure.

---

## 4. Deliverables — demo video script (end-to-end)

A single sitting that shows the whole loop:

1. **Greeting** — "hi" → friendly, no retrieval (selective RAG). *(#11)*
2. **Grounded KB answer** — "What's your seller commission?" → 5% split. *(#1)*
3. **Correct decline** — "average price in The Cove right now?" → declines, offers a human. *(#7)*
4. **Skill: update contact** — "I'm Alex, alex@example.com, budget 550k" → saved; show the contact in the CRM. *(#14)*
5. **Skill: booking** — "book a viewing tomorrow afternoon" → offers slots → "yes, the first one" → confirmed; show the appointment. *(#20–21)*
6. **Skill: handover** — "get me a human" → bot stops, contact tagged; show it in the CRM inbox. *(#17)*
7. **Trace walkthrough** — open one turn in Langfuse: prompt, model, RAG chunks + scores, tool I/O, tokens, latency. *(#26)*
8. **Provider switch** — flip `LLM_PROVIDER`, re-ask the commission question, show the new model in the trace. *(#27)*

---

### KB facts used above (Demo Realty)
Seller commission **5%** (2.5% / 2.5%) · rentals **8%** monthly · first-time **Demo First Key**, up to
**$2,500** credit · hours **Mon–Fri 9–6, Sat 10–4, closed Sun** · neighborhoods **The Cove, Old Town,
Maple Heights, Dockside, Vista Ridge**. Out-of-KB (must decline): live prices, mortgage rates, legal
advice, weather.
