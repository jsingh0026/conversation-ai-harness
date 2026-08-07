# Conversation AI Agent Harness

An agent harness that powers a [HighLevel](https://www.gohighlevel.com/) Conversation AI agent
end-to-end: it receives an inbound customer message, decides what to do (answer from a knowledge
base, run a skill, or hand over to a human), executes it, and replies back into the CRM
conversation — with a full, inspectable trace of every step.

> 📄 Full assignment spec: [`docs/ASSIGNMENT.md`](./docs/ASSIGNMENT.md)

## Status

🚧 **Scaffolding.** Repo initialized and spec ingested. Architecture and implementation to follow.

## What it does (target)

- **Multi-provider LLM** — Claude, OpenAI, Gemini behind one abstraction; switch via config.
- **RAG-triggered knowledge base** — retrieves *only* when needed; grounded answers or an honest
  "I don't know" / handover.
- **Skills framework** — Update Contact Field, Human Handover, Appointment Booking; adding a skill
  is registration, not core surgery.
- **Execution transparency** — every turn emits a trace (prompt, model, RAG chunks + scores, skill
  I/O, CRM calls, tokens, per-step latency).
- **Evals** — one-command suite for RAG trigger precision/recall, groundedness, skill firing
  (incl. negative cases), and per-provider latency.

## Getting started

_TBD — install / sandbox connection / run instructions land here as the harness is built._
