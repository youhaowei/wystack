---
name: groom
description: "Codebase-aware task grooming and implementation planning. Single-task mode: pass a Notion URL. Batch mode: pass a project name to groom multiple tasks."
---

# Plan Task

Interactive, codebase-aware grooming and implementation planning. Merges backlog refinement with plan writing into one adaptive skill.

## Input

Task reference: `$ARGUMENTS`

- **Notion URL** → Single-task mode (groom + plan one task)
- **Project name** (e.g., "knowledgebase") → Batch mode (groom multiple tasks)
- **Empty** → Infer project from CWD, enter batch mode

## Prerequisites

Load these into YOUR context (needed for orchestration):

```
Read ~/.claude/skills/notion/workspace.md
Read ~/.claude/skills/estimation/SKILL.md
```

## Architecture

| Concern | Where | Why |
|---------|-------|-----|
| Refinement decisions, user interaction | **Main Opus** | Needs conversation history |
| Notion search & fetch | **`notion-researcher` subagent** | Verbose API responses stay out |
| Codebase exploration | **`Explore` subagent** | File contents stay out |
| Notion writes | **`notion-writer` subagent** | Confirmation noise stays out |

---

## Single-Task Mode (Notion URL provided)

### 1. Fetch Task Details

Spawn **`notion-researcher`** (haiku) to fetch the task page. Return: title, status, priority, estimate, description, acceptance criteria, relations, linked specs.

### 2. Groom (if needed)

Skip grooming if the task already has ALL of: estimate, acceptance criteria, and scope definition.

**If grooming needed**, spawn **two subagents in parallel**:

**`notion-researcher`** — Fetch related tasks (blocked-by, blocking, parent) for dependency context.

**`Explore` subagent** — Given task title + description, explore the codebase:

```
Task: "{title}"
{description}

Using the estimation scale (XS through XXL), analyze:

1. **Affected files** — paths + brief rationale
2. **Implementation complexity** — files changed, new vs existing patterns, test infrastructure
3. **Suggested estimate** — use the scale with reasoning:
   - What model/agent tier would execute this?
   - Apply multipliers/reducers from the estimation heuristics
4. **Full scope at that estimate tier**:
   - What tests are required? (unit, integration, edge cases)
   - What docs need updating? (CLAUDE.md, inline, API docs)
   - Any migration needed?
5. **Suggested acceptance criteria** — concrete, testable, referencing actual file paths
6. **If L+ size** — suggest how to split based on code module boundaries

Exploration depth: "quick" for likely S/M, "very thorough" for likely L+.
```

Present grooming results:

```
### TASK-{id}: {title}
Status: {status} | Priority: {priority} | Current estimate: {est} | Type: {type}

**Description**: {summary}

**Codebase Analysis**:
- Files: {affected files}
- Suggested estimate: **{size}** ({model tier}) — {reasoning}
- Full scope at {size}:
  - Tests: {what's required}
  - Docs: {what needs updating}
  - Migration: {if any}

**Suggested Acceptance Criteria**:
1. {criterion referencing code}
2. {test criterion}
3. {doc criterion}
```

Use `AskUserQuestion` (multiSelect) for triage:
- **Accept suggestions** — Apply estimate + ACs + scope
- **Reprioritize** — Change priority
- **Re-estimate** — Override suggestion
- **Redefine** — Update title/description/ACs
- **Split** — Break into sub-tasks (present code-informed splits)
- **Skip grooming** — Jump straight to planning

### 3. Plan (always)

Spawn **`Explore` subagent** for deep codebase exploration focused on implementation:

```
Task: "{title}"
{description}
{acceptance criteria}

Create a detailed implementation plan:

1. **Ordered implementation steps** — concrete changes with:
   - Specific files, functions, and line ranges
   - Existing patterns to follow (cite examples in codebase)
   - Exact insertion points for new code
   - Design decisions that need user input
2. **Test strategy** — what to test, which test files, existing test patterns to follow
3. **Dependencies** — order of operations, what must be done first
4. **Risk areas** — parts most likely to need iteration

Exploration depth: "very thorough"
```

Present the plan:

```
### Implementation Plan

**Steps**:
1. {step with specific file + function + what to change}
2. {step referencing existing pattern to follow}
3. {step for tests}
4. {step for docs if needed}

**Test Strategy**: {approach}
**Risk Areas**: {what might need iteration}
```

Use `AskUserQuestion`:
- **Question**: "Write this plan to the Notion task page?"
- **Header**: "Save plan"
- **Options**:
  - **Save to Notion** — "Write plan to the task page under ## Plan"
  - **Revise** — "I want to change the plan"
  - **Skip saving** — "Don't save, I'll use it from memory"

### 4. Apply Changes

Spawn **`notion-writer`** subagent to:
- Update properties (estimate, priority)
- Append acceptance criteria under `## Acceptance Criteria`
- Append scope definition under `## Scope` (files, tests, docs, migration)
- Write implementation plan under `## Plan`
- Set status to **Ready** if all criteria met:
  - Has an estimate
  - Has acceptance criteria
  - Has a scope definition
  - Is not blocked by an incomplete task

### 5. Report

```
### Summary

TASK-{id}: {title}
- Estimate: {old} → {new} ({model tier})
- Status: {old} → {new}
- Added: {what sections were written}

Ready to implement? Run `/engineering:start {task-url}`
```

---

## Batch Mode (project name or empty)

### 1. Lightweight Overview

Spawn **`notion-researcher`** to search tasks for the project. Return **only**: task count by status + compact list (ID, title, status, priority, estimate). No descriptions, no page fetches.

Present the overview.

### 2. Ask Scope

Use `AskUserQuestion` **before fetching details**:

- **Full sweep** — Every non-Done task (warn if >15)
- **Quick triage** — Missing estimate, priority, or acceptance criteria
- **Stale tasks** — Stuck in Not Started / Later
- **Specific epic** — Drill into one area

### 3. Per-Task Loop

For each task in scope, run Single-Task Mode (Steps 1-5 above).

Use `AskUserQuestion` between tasks:
- **Continue** — Next task in the batch
- **Stop here** — End the batch

### 4. Session Summary

```
## Planning Summary

### Changes
- TASK-{id}: {title} — estimate: ? → M (Opus), added ACs + plan → **Ready**
- TASK-{id}: {title} — priority: Medium → High → **Ready**
- TASK-{id}: {title} — split into 3 sub-tasks

### Promoted to Ready ({count})
- TASK-{id}: {title} (High, M) — has estimate, ACs, scope, plan, unblocked

### Still Needs Work ({count})
- TASK-{id}: {title} — missing: {what's missing}

### Updated Priority Stack (Ready tasks first)
1. TASK-{id}: {title} (High, S/Sonnet) — Ready
2. TASK-{id}: {title} (High, M/Opus) — Ready
...

### Stats
Reviewed: {n} | Changed: {n} | Created: {n} | Archived: {n}
```

### 5. Follow-up

- "Run `/engineering:start` to start implementing?"
- "Done"

---

## Interaction Principles

- **Scope first, fetch later** — ask what to review before pulling details
- **Parallel subagents** — Notion + Explore always concurrent when possible
- **One task at a time** — in batch mode, fully process each before moving on
- **Estimation includes full scope** — tests, docs, migration are part of the estimate
- **Adaptive depth** — if user is moving fast, reduce Explore thoroughness
- **Main context stays clean** — only synthesized summaries
- **Auto-promote to Ready** — when all criteria met after grooming + planning
