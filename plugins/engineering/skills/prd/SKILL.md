---
name: prd
description: "Write a Product Requirements Document — a formal behavior spec describing what the system should do from the user's perspective. Use when a feature needs documentation before breakdown into tickets. Triggers on: \"write a PRD\", \"document this feature\", \"behavior spec\", \"product requirements\", or after /brainstorm produces a design that needs formal documentation."
---

# PRD

Write a behavior spec that clearly documents what the system should do. The PRD is the source of truth that tickets reference — it outlives individual tasks.

`$ARGUMENTS` — feature description, brainstorm output, or empty (interactive).

## What a PRD Captures

- **Purpose and problem** — why this exists, what pain it solves (2-3 sentences each)
- **Target users** — who uses this and what they care about
- **Goals and non-goals** — what we're optimizing for and explicitly not doing
- **User stories** — one sentence each. "As a [role], I want [goal], so that [value]." Group by concern. Detailed acceptance criteria belong on tickets, not the PRD.
- **Example scenarios** — concrete examples that illustrate how the system works in practice
- **Edge cases and error states** — table of what-if scenarios and expected behavior
- **Dependencies and phasing** — what this builds on, what order things ship

## How to Write It

1. **Research** — explore the codebase, read existing docs, check Notion for related specs. Understand what exists.
2. **Interview** — use `/brainstorm --grill` to explore and clarify requirements. Every assumption should be challenged, every branch of the decision tree resolved before writing.
3. **Write stories as one-liners** — the PRD captures scope and intent. Each story is one sentence. Detailed acceptance criteria are written when tickets are created, not upfront.
4. **Completeness over detail** — make sure every use case has a story. Missing a story is worse than a story missing details.
5. **Write behaviors, not implementation** — "User can undo a fork" not "Add an undo button that calls revertFork()".
6. **Save** — store as a Notion page (preferred). Link to spec and related tasks/epics.

## Rules

- **Stories are one-liners** — detailed AC lives on tickets. The PRD is a map, not a manual.
- **Complete coverage** — every user-facing use case has a story. Gaps are caught here, not during implementation.
- **User language, not code** — someone non-technical should understand the PRD
- **Living document** — update when scope changes
- **Separate from tickets** — PRD is the spec, tickets are the work items. `/engineering:breakdown` converts one to the other.
