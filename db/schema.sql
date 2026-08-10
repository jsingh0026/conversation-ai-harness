-- Conversation AI Harness — core Postgres schema (no extensions required).
-- Applied by `pnpm db:migrate`. Idempotent: safe to run repeatedly.
--
-- Only what the harness owns and that needs durability without an extension:
--   processed_messages — webhook idempotency keys (ephemeral bookkeeping)
-- The pgvector KB lives in db/schema-pgvector.sql (opt-in; see PGVECTOR env).
-- Contacts, conversations and messages are NOT stored here — HighLevel is their
-- system of record; we reference them by id.

-- Webhook idempotency with a processing lease. One row per inbound message id:
-- `processing` while a turn runs, `done` on success. A crash leaves a stale
-- `processing` row that is reclaimed after the lease, so a retry isn't lost.
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id      TEXT PRIMARY KEY,      -- HL message id, or our gen_<sha1> for live-chat
  conversation_id TEXT,                  -- for traceability only
  status          TEXT NOT NULL DEFAULT 'processing',  -- 'processing' | 'done'
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent add for tables created before the lease column existed.
ALTER TABLE processed_messages
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'processing';

CREATE INDEX IF NOT EXISTS processed_messages_processed_at
  ON processed_messages (processed_at);

-- HighLevel OAuth token (single row, id = 'default'). Stored here so it survives
-- deploys — on Fly the machine filesystem is ephemeral, so a file-based token is
-- lost on every deploy. Only used in OAuth mode (HL_PRIVATE_TOKEN unset).
CREATE TABLE IF NOT EXISTS hl_oauth_token (
  id            TEXT PRIMARY KEY,            -- always 'default'
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    BIGINT NOT NULL,             -- epoch ms
  location_id   TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
