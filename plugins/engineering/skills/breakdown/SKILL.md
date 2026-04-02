---
name: breakdown
description: "Turn a PRD or feature spec into actionable vertical-slice tickets. Takes a Notion PRD URL or doc path, breaks it into independently implementable slices, creates tickets. Use when a feature is defined but not yet split into work items."
---

# Breakdown

Turn a PRD into actionable tickets. Load `~/.claude/skills/notion/workspace.md` first.

`$ARGUMENTS` — Notion PRD URL, `/spec` URL, doc path, or empty (search for recent PRDs/specs).

## Flow

### 1. Load PRD + Spec
Fetch the PRD (what to build) and spec (key decisions, architecture). Understand: user goals, system boundaries, and the architectural decisions that inform how to slice.

### 2. Explore Codebase
Understand what exists: affected modules, integration points, existing patterns, test infrastructure. This informs where to draw slice boundaries.

### 3. Slice Vertically
Break the PRD into **vertical slices** — each cuts through all layers (UI, service, data) as a thin complete feature. Each slice should be:
- Independently implementable via `/tdd`
- Testable end-to-end on its own
- A "tracer bullet" that proves integration works

Order slices so the first one is the thinnest possible end-to-end path. Later slices add depth. Dependencies between slices should be explicit.

### 4. Phase Into Tracer Bullets
Group slices into phases. Phase 1 is the thinnest end-to-end tracer bullet — proves integration across all layers. Later phases add depth, edge cases, polish. Each phase should be shippable.

### 5. Create Tickets
Each slice becomes a ticket referencing both the PRD (which stories it satisfies) and the spec (which architectural decisions apply). Include: what this slice does, acceptance criteria, suggested test approach, dependencies on other slices.

## Splitting Techniques (SPIDR)

When a slice is still too big, split by:
- **Spike** — extract unknowns into research tickets first
- **Paths** — split by alternative flows (happy path first, error handling later)
- **Interfaces** — split by input/output method
- **Data** — split by data variations (simple case first, complex later)
- **Rules** — split by business rules (basic first, edge cases later)

## Ticket Quality (INVEST)

Each ticket should be:
- **Independent** — can be worked on in any order (minimize dependencies)
- **Negotiable** — not over-specified, room for implementation judgment
- **Valuable** — delivers visible user value, not just technical infrastructure
- **Estimatable** — clear enough to size
- **Small** — completable in one sprint
- **Testable** — acceptance criteria can be written immediately

## Principles

- **Vertical, not horizontal** — "login form → API → DB → response" not "all UI first, then all backend"
- **Thin first** — the first slice should be embarrassingly simple but fully integrated
- **Each slice is TDD-ready** — clear enough to write a failing test for
- **Reference the PRD** — tickets link back to the behavior spec, don't duplicate it
- **Stories, not tasks** — "user can see workflow progress" not "build the progress tracking service"
