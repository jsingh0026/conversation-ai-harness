# Knowledge Base — adding & ingesting a document

The KB is just **markdown files in `kb/`**. To add knowledge the agent can answer from, drop a
`.md` file in `kb/` and re-run ingest. That's it — no database of entities/relations, no wiki layer;
retrieval is chunk → embed → vector search, with an optional provenance header per doc.

---

## TL;DR (local, ~1 minute)

```bash
# 1. Add a markdown file (see format below)
cat > kb/parking.md <<'MD'
# Parking at viewings
Street parking is free on weekends. On weekdays, use the Harbor Street garage;
Demo Realty validates up to 2 hours for scheduled viewings.
MD

# 2. Re-embed the KB
pnpm ingest          # → data/index/kb.json  (on-device embeddings; needs EMBED_LOCAL=true)

# 3. Run and ask
pnpm dev
curl -sX POST localhost:3000/webhook -H 'content-type: application/json' \
  -d '{"contactId":"ct1","conversationId":"c1","body":"where do I park for a viewing?","messageType":"SMS"}'
pnpm trace latest    # see the retrieval step: which chunk + score
```

A plain markdown file works on its own. Headings matter — the chunker is **heading-aware**, so use
`#` / `##` sections and keep each doc focused on one topic (better retrieval precision).

---

## File format

**Minimum** — plain markdown with headings:

```markdown
# Topic
A concise, factual answer. Keep sections focused; one topic per file.

## Sub-topic
More detail the agent can quote.
```

**Recommended** — add an **OKF provenance header** (YAML frontmatter) so retrieval is
provenance-aware. The header is **stripped before embedding** (never retrieved as text); only the
fields below are acted on:

```markdown
---
type: policy                       # free-form label (not enforced)
title: Parking at viewings
sources:
  - id: ops-handbook               # ← used as the citation key + shown in the trace
    resource: /policies/ops.pdf
    author: human:broker
status: stable                     # draft | stable | deprecated
verified:
  - { by: human:broker, at: 2026-06-01 }   # latest entry → "verified by / at" in the trace
stale_after: 2026-12-31            # after this date the doc is treated as stale
---
# Parking at viewings
Street parking is free on weekends...
```

**What each acted-on field does** (see `src/rag/okf.ts`):
| Field | Effect on retrieval |
|---|---|
| `status: deprecated` | Matches are **declined** (never quoted) with reason `stale` |
| `stale_after` past today | Same — declined as out-of-date |
| `verified[].by` / `.at` | Latest entry shown in the trace / Langfuse `sources` (trust + freshness) |
| `sources[0].id` | Citation key surfaced in the trace |
| everything else (`title`, `tags`, `type`, …) | metadata only — not parsed |

Frontmatter is optional: omit it and the doc still ingests (just with no provenance).

---

## Ingesting

| Command | Target | When |
|---|---|---|
| `pnpm ingest` | `data/index/kb.json` (file index) | local default; needs `EMBED_LOCAL=true` (or an embed provider) |
| `pnpm ingest:pg` | Postgres **pgvector** (`kb_chunks`) | when `DATABASE_URL` + `PGVECTOR=true` (local pgvector or prod) |

Both re-embed **all** of `kb/` and replace the prior index for that embed model, so removed/renamed
docs don't linger. Ingest is deterministic (no LLM) and takes a few seconds.

Verify it landed:
```bash
# file index:
node -e "console.log(require('./data/index/kb.json').chunks.filter(c=>c.docId==='parking'))"
# pgvector:
psql "$DATABASE_URL" -c "SELECT doc_id, status, stale_after FROM kb_chunks WHERE doc_id='parking';"
```

---

## Getting a new doc into production

There is **no separate KB pipeline** — a document reaches prod on the next **`fly deploy`**, which
re-ingests automatically in two places:

1. **Build time (`Dockerfile`)** — `RUN … pnpm ingest` bakes the file index into the image, and the
   raw `kb/` is copied in.
2. **Deploy time (`fly.toml` `release_command`)** — `migrate.js && ingest-pg.js` re-embeds all of
   `kb/` into **pgvector** before the new version takes traffic (prod runs `PGVECTOR=true`).

So the full flow is: **add `kb/your-doc.md` → commit → `fly deploy`** → it's live in both the file
index and pgvector. (There is no GitHub Actions CI, so a `git push` alone does not deploy — run
`fly deploy`.)

---

## What this KB is *not*

It's classic provenance-aware RAG, **not** an LLM-maintained "wiki" (no entity/relation extraction,
no auto-generated cross-referenced pages, no `index.md`/`log.md`). Each `kb/*.md` is authored by a
human and ingested as-is. The compounding-wiki upgrade path is sketched in
[`OKF_DESIGN.md`](./OKF_DESIGN.md) for if/when the KB grows.
