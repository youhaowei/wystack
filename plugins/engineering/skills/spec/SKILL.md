---
name: spec
description: "Write a technical specification — system design, component boundaries, data flow, API contracts, and key decisions. The engineering counterpart to /prd. Use when architecture needs documenting before implementation. Triggers on: \"write a spec\", \"tech spec\", \"design doc\", \"architecture doc\", \"system design\", or after /brainstorm produces architecture that needs formal documentation."
---

# Spec

Write a technical specification that documents how the system is designed. The spec is the engineering counterpart to the PRD — PRD defines what, spec defines how.

`$ARGUMENTS` — feature/system description, PRD reference, or empty (interactive).

## What a Spec Captures

### Concepts and Framing
- **What this is / isn't** — one paragraph positioning
- **Key concepts** — the vocabulary of the system. Define once, use everywhere.
- **Design principles** — the rules that guide decisions

### Architecture (the core)
- **Component boundaries** — what modules/services exist, what each owns, how they communicate. Diagram preferred.
- **Data flow** — how data moves through the system end-to-end
- **Key decisions** — trade-offs considered, what was chosen and why. "We use X because Y, not Z because W" is the atomic unit of a spec.
- **Integration points** — where this touches other systems, dependencies
- **Migration strategy** — if changing existing architecture, how to get from A to B

### Open Questions
- What needs spikes or further design
- What's explicitly deferred

## Level of Detail

**Too light (just vibes):**
> "The engine runs workflows with agents."

**Right level (architecture + decisions):**
> "The engine has two primitives: a concurrency pool (max N agents, auto-fills from ready work) and an ask queue (agents post human decisions, engine parks and resumes). We chose append-only JSONL for execution logs over SQLite because it matches the existing session persistence pattern and supports crash recovery via replay."

**Too heavy (implementation code):**
> ```typescript
> interface ExecutionRecord = { t: 'node_start', nodeId: string, ts: number } | ...
> ```

Describe shape and intent. TypeScript interfaces, schemas, and record formats belong in the codebase, not the spec.

## How to Write It

1. **Research** — explore the codebase, understand existing architecture. The principal-engineer agent is a good collaborator.
2. **Challenge trade-offs** — use `/brainstorm --grill` to explore architectural alternatives before committing. Every decision should be stress-tested. Document what was considered and why.
3. **Reference the PRD** — the spec implements the behaviors described in the PRD.
4. **Decisions over descriptions** — focus on the non-obvious. Document WHY, not just WHAT.
4. **Diagrams over prose** — component boundaries and data flow are almost always clearer as diagrams.
5. **Save** — store as a Notion page (preferred). Link to the PRD and related tickets.

## Rules

- **Complements the PRD** — PRD says what, spec says how. Don't duplicate.
- **Decisions are the core** — if there's no decision to document, there's no spec to write
- **Architecture, not implementation** — component boundaries and data flow, not TypeScript interfaces
- **Living document** — update when architecture changes
- **Feeds into /engineering:breakdown** — the spec + PRD together define what gets split into tickets
