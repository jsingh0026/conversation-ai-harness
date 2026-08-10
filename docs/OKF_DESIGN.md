# OKF-formatted KB + provenance-in-the-trace — design sketch

Status: **design only, not implemented.** Explores adopting Google's
[Open Knowledge Format (OKF)](https://www.mindstudio.ai/blog/what-is-open-knowledge-format-okf-google-ai-knowledge-bases)
as the KB *authoring format* while keeping our vector retrieval as the *finder*.

**The framing.** The "OKF replaces the vector database" headline is overstated — even OKF's
advocates note *"OKF does not replace embeddings; vector retrieval still does recall. Rather, OKF
kills blind chunking."* OKF and RAG solve **different** problems: OKF is how you *represent & govern*
knowledge (structure, provenance, freshness, links); vector RAG is how you *find* the right piece from
a fuzzy question (semantic recall + a confidence score to decline). So the design here is
**OKF-as-format + RAG-as-finder + provenance-in-the-trace**, not a retrieval rewrite.

For our current **14-doc, static KB** the payoff is modest (docs are already small + self-contained).
This is the **"if the KB grew / needed governance" upgrade path**, captured for the writeup.

---

## 1. A KB doc today → the same doc in OKF

**Now** (`kb/fees-and-commissions.md`) — plain markdown, no metadata:

```markdown
# Fees and Commissions
Sellers pay 5% of the final sale price, split 2.5% to Demo Realty and 2.5% to the buyer's agent.
For rentals, landlords pay 8% of monthly rent for management.
```

**OKF version** — markdown + YAML frontmatter (structure, provenance, freshness, links):

```markdown
---
type: policy
title: Seller & Rental Commissions
description: What Demo Realty charges to sell a home or manage a rental.
tags: [fees, selling, rentals]
sources:
  - id: fee-schedule
    resource: /policies/fee-schedule-2026.pdf
    author: human:broker
    last_modified: 2026-05-01
generated: { by: human:jaspreet, at: 2026-05-01T10:00:00Z }
verified:
  - { by: human:broker, at: 2026-06-01T09:00:00Z }
status: stable            # draft | stable | deprecated
stale_after: 2026-12-31
---
# Seller commission
Sellers pay **5%** of the final sale price — 2.5% to Demo Realty, 2.5% to the buyer's agent.[^fee-schedule]

# Rentals
Landlords pay **8%** of monthly rent for management.[^fee-schedule]

See also: [First-time buyers → Demo First Key](/kb/first-time-buyers.md).
```

## 2. What the ingester does (small change to `chunk.ts` + `ingest.ts`)

Parse the frontmatter, chunk the body **heading-aware as now**, but **stamp each chunk with the
concept's provenance**. Embeddings unchanged — we just embed coherent concepts + attach metadata.

```ts
type EmbeddedChunk = {
  id; docId; title; section; text; embedding;
  // NEW — carried from OKF frontmatter:
  provenance?: {
    status: 'draft' | 'stable' | 'deprecated';
    verifiedBy?: string; verifiedAt?: string;
    staleAfter?: string; sourceId?: string;
  };
};
```

## 3. The retrieval trace gains provenance (extends what's already emitted)

`RetrievalStep.chunks` today = `{docId, score, text}`. Add provenance → the Langfuse **sources**
already shown get richer:

```
2·retrieval:grounded   threshold 0.35
  sources:
   - fees-and-commissions   kb/fees-and-commissions.md   0.83
       status: stable   verified: human:broker@2026-06-01   fresh_until: 2026-12-31   src: fee-schedule
   - selling-process        kb/selling-process.md         0.81   status: stable …
```

The trace now answers not just *"which doc"* but *"is it trusted, human-verified, and still fresh?"*

## 4. Grounding becomes provenance-aware (a few lines in `retriever.ts`)

```ts
const usable = grounded.filter(
  (c) => c.provenance?.status !== 'deprecated' && !isPast(c.provenance?.staleAfter),
);

if (usable.length === 0 && grounded.length) {
  // matched, but only stale/deprecated content
  return { grounded: false, reason: 'stale', chunks: grounded };
}
// prefer verified + stable when ranking ties
```

Behavior:
- Fresh, verified `stable` doc → answer normally (as today).
- Only a `deprecated` / past-`stale_after` chunk matched → **`grounded:false` with reason `stale`** →
  the agent declines / offers a human ("that policy may have changed — let me connect you with an
  agent") instead of confidently quoting outdated info.
- Optional: append the citation (`[^fee-schedule]`) to the reply.

## 5. What actually changes (all behind existing seams)

| File | Change |
|---|---|
| `kb/*.md` | add OKF frontmatter (content authoring) |
| `rag/types.ts` | `provenance` on `Chunk` / `EmbeddedChunk` / `RetrievalStep` |
| `rag/chunk.ts` + `ingest.ts` | parse frontmatter, stamp chunks |
| `rag/retriever.ts` | provenance-aware filter + `stale` decline |
| `trace/exporters/langfuse.ts` | show `status` / `verified` / `fresh_until` in `sources` |

**No new infra, no retrieval rewrite** — embeddings, the file/pgvector index, and the tool-loop are
untouched.

## Upside vs. cost

- **Upside:** stronger *groundedness* (declines stale/deprecated, not just low-similarity) and richer
  *transparency* (trust + freshness in every trace) — both graded criteria.
- **Cost:** modest for a 14-doc static KB; authoring overhead per doc; OKF is early (v0.1, GCP-incubated).
- **Recommendation:** don't build now — document as the governance/scale upgrade path; adopt the OKF
  frontmatter subset (provenance) first if/when the KB grows or needs auditability.

## References
- [MindStudio: What is OKF](https://www.mindstudio.ai/blog/what-is-open-knowledge-format-okf-google-ai-knowledge-bases) ·
  [Analytics Vidhya](https://www.analyticsvidhya.com/blog/2026/07/open-knowledge-format-okf/) ·
  [HPE: OKF vs. RAG](https://community.hpe.com/t5/ai-unlocked/open-knowledge-format-vs-rag-rethinking-how-ai-agents-get-their/ba-p/7270244) ·
  [OKF SPEC](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
