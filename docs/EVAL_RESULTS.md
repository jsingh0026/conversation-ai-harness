# Eval Results

> How to reproduce the eval results and record them here with a candid failure analysis.
> The numbers below are **placeholders** — run the suite with your API keys to populate them.

## Reproduce

```bash
pnpm ingest                 # build the KB index (needs an embedding key)
pnpm eval                   # all providers that have an API key, all suites
# or narrow it:
pnpm eval claude
pnpm eval openai handover latency
```

The runner prints a per-provider table plus a failure list, and exits non-zero if anything failed or
errored. Paste the table below and add a short analysis of the notable failures.

## Results (per provider)

Headline metrics — `rag-trigger`/skills show precision / recall; `groundedness` shows grounded% /
decline%; `latency` shows p50 / p95.

| Provider | rag-trigger | groundedness | update-contact | handover | appointment | latency |
|---|---|---|---|---|---|---|
| **claude** (`claude-sonnet-5`) | — / — | — / — | — / — | — / — | — / — | — / — |
| **openai** (`gpt-4.1`) | — / — | — / — | — / — | — / — | — / — | — / — |
| **gemini** (`gemini-2.0-flash`) | — / — | — / — | — / — | — / — | — / — | — / — |

## Failure analysis (fill in after a run)

For each provider, note:
- **Which cases failed and why** — copy the failing case ids + details the runner prints. Is it a
  model miss (wrong decision), a borderline gold label, or an infra error?
- **RAG-trigger** — false positives (retrieved on chit-chat) vs false negatives (missed a factual
  question). Where does each provider sit?
- **Groundedness** — did any provider fabricate on a decline case (caught by the fabricated-figure
  check)? Did any correct grounded answer fail the fact match (phrasing the boundary matcher missed)?
- **Skills** — negatives that wrongly fired; positives that fired but missed a field.
- **Latency** — p50/p95 per provider vs the 3s/6s targets; note that RAG turns (two round-trips) are
  excluded from the latency suite by design.

## Method notes (honesty)

- **Grounded-fact matching is deterministic** (boundary/number-aware substring match against expected
  facts). This can still miss a correct answer that phrases a fact unusually — treat a groundedness
  failure as "investigate," not necessarily "model wrong."
- **Decline detection is heuristic**: a decline passes unless the reply asserts a specific `$`/`%`
  figure (fabrication) or is the generic fallback. It won't catch a fabrication with no numbers. A
  stronger version would use an LLM judge; that's a documented future improvement.
- **Latency depends on network + provider load** at run time; report the machine/region and run it a
  couple of times.
- Cases live in `evals/cases/*.json` (116 total) and are gold-labeled to be unambiguous; if you
  disagree with a label, that's a legitimate finding to note here.
