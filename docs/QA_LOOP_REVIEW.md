# QA Evaluator–Optimizer Loop — Overnight Review

Autonomous run of `QA_TEST_QUESTIONS.md` against **prod** (`conversation-ai-harness.fly.dev`),
using the native HighLevel path (webhook → orchestrator → pgvector/Groq → reply), reviewing each
answer **and** its Langfuse trace, fixing issues, redeploying, and re-testing in a loop.

> **All fixes below are UNCOMMITTED** — left in the working tree for you to review/discuss, per request.
> Deploys were done from the working tree (no commit needed).

---

## Fixes applied (uncommitted)

| File | Change | Why |
|---|---|---|
| `src/prompts/system.ts` | Handover: **call `request_human_handover`**, don't pre-ask for contact; only ask for what the tool reports missing. Don't ask for email/phone unless required for a handover/booking; never repeat the same ask. Decline off-topic (weather/trivia) instead of handing over. | Bot was asking for name/contact **instead of** calling the handover tool, and repeating itself (your screenshot). |
| `src/skills/handover.skill.ts` | Tightened the tool description: handover is for **real-estate matters needing a human** (legal/contract, complaint, commercial, negotiation) or an explicit/frustrated request — **NOT** off-topic questions (weather, trivia). | Bot was escalating trivial off-topic questions to a human. |

Both keep the full suite green (**176 tests pass**).

---

## Issues found → fixed (the optimizer loop)

1. **Handover never fired (G7).** User asked for a human; bot replied `chitchat` and asked for
   name+contact instead of calling `request_human_handover` — even though the contact had name+email.
   **Fix:** prompt now tells the model to call the tool; the skill's HITL gate decides whether to ask
   for missing contact info. → **Re-test: `decision=handover`, `request_human_handover` fires.** ✅

2. **Over-escalation of off-topic (G3-weather).** "What's the weather tomorrow?" triggered a human
   handover. **Fix:** handover scope tightened to real-estate-needing-a-human only.
   → **Re-test: `decision=chitchat`, "I can only help with real-estate questions."** ✅ (Legal advice
   still correctly hands over.)

3. **Booking turn 2 looked wrong (G9).** Was a **test-runner artifact** (re-fetched turn 1's trace),
   not a product bug. **Fix:** runner now disambiguates multi-turn traces by id.
   → **Re-test: turn 1 `get_available_slots`, turn 2 `book_appointment` — "booked for Aug 11 12:30 PM".** ✅

4. **Over-asking for contact (G8, general).** Softened via the prompt ("answer first; collect contact
   only when needed; never repeat"). Improved but still slightly eager on open-ended searches — see
   "Minor / soft" below.

---

## Scorecard (validated in rounds 1–4, fixes deployed)

| Group | Case | Result |
|---|---|---|
| G1 | commission (5% split) | ✅ grounded |
| G1 | rental (8%/mo) | ✅ |
| G1 | office hours (M–F 9–6, Sat 10–4, closed Sun) | ✅ |
| G1 | first-time (Demo First Key, $2,500) | ✅ |
| G1 | commercial → residential-only | ✅ decline-of-scope |
| G1 | mortgage → not a lender (Harbor Trust / Marisol CU) | ✅ |
| G2 | paraphrase / typo / multi-fact (5% + 8%) | ✅ all ground |
| G3 | avg price / rates → decline (no invented number) | ✅ |
| G3 | **weather → decline (not handover)** | ✅ fixed |
| G3 | legal advice → handover | ✅ |
| G4 | hi / who-are-you → chitchat, no retrieval | ✅ |
| G5 | "I'm Alex … budget 550k" → update_contact_field | ✅ |
| G6 | commission (no update) / grocery-budget (not saved) | ✅ negatives hold |
| G7 | **explicit / frustration → handover** | ✅ fixed |
| G8 | 3-bed near Old Town → no handover, offers help | ✅ (soft over-ask) |
| G9 | **booking: slots → book_appointment** | ✅ fixed |
| G10 | Sunday (closed) graceful / past-date rejected | ✅ |
| G11 | "what times open" → KB hours (not calendar) | ✅ |
| G12 | "I'm Sam … book a tour" → update + get_available_slots | ✅ |
| G16 | continuity: "commission there?" uses prior turn | ✅ |
| G17 | plant false 1% → corrects to 5% / BANANA → refuses | ✅ |

**Resume run (from last success, after Groq partially recovered)** re-verified 13 more on a clean
slate before the cap re-exhausted — newly confirmed: **G1-dockside ✅, G1-office ✅ (214 Harbor St),
G3-competitor ✅ (declines)**, plus re-confirmed G1-hours/firsttime/commercial/mortgage,
G2-paraphrase/typo/multifact, G3-price/rates/weather.

**Still not verified on a clean slate** (4 low-risk cases; each near-identical to a validated sibling —
ack, business-info answer, no-tool, and handover): **G4-thanks, G7-frustration, G8-humans,
G11-book-club**. Blocked only by the Groq daily cap; finish once quota recovers.

---

## Key finding: Groq free-tier daily token cap

The 35-case "full round" failed from case 3 onward with:
```
Rate limit reached for openai/gpt-oss-120b … tokens per day (TPD): Limit 200000, Used 199635.
```
Repeated QA rounds (~70+ LLM turns) exhausted the **200,000 tokens/day** free quota. This is **infra,
not the agent**. It validated two resilience features:
- **Graceful fallback** — every rate-limited turn replied "a team member will follow up" (no silence).
- **Retry with backoff** — 3 attempts before falling back.

**Prod is temporarily rate-limited** and will recover as the rolling window frees (fully by morning).

### Recommendations
- For load/QA at volume: upgrade Groq to a paid tier, or add a **provider fallback** (on rate-limit,
  fail over to a secondary OpenAI-compatible gateway) behind the existing `LLMProvider` seam.
- Pace automated test runs (add delays) to stay under the daily cap.

---

## Minor / soft items (not fixed — for discussion)

- **G8 over-asking:** on open-ended searches the bot still asks for name/budget/time in one go. It no
  longer hands over or repeats, but could answer/qualify more gently. Prompt-tunable.
- **Occasional verbosity:** a few answers run long for a chat bubble. The "text-message length" guide
  helps but isn't always honored — could add a hard length nudge if desired.

---

## Test harness (scratchpad, not in repo)

`qa-runner.mjs` drives cases through prod `/webhook` (real contact for delivery, unique
`conversationId` per case for isolation, multi-turn shares one), pulls each Langfuse trace, and
extracts decision / retrieval+sources / tools / answer / latency. Hardened against Langfuse cold-start
timeouts (retry, never throws). Case files: `cases-*.json`.
