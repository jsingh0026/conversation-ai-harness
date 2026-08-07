# HighLevel Sandbox Setup

What to create in HighLevel and the values to drop into `.env` so the harness can run end-to-end.
Auth path: **Marketplace app + OAuth**. The harness is built mock-first (Phases 0–6 need none of
this); this is the Phase 7 wiring checklist.

## 1. Accounts
1. Create a **HighLevel developer/agency account** and a **sub-account (Location)** to test in.
2. Note the **Location ID** → `HL_LOCATION_ID`.

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
