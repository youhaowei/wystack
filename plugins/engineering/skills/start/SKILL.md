---
name: start
description: "Full task lifecycle orchestrator. Takes a Notion task from any status through to completion: groom, worktree, implement, finish. Pass a Notion URL, task ID, or omit to pick via /engineering:next."
---

# Do Task

State-machine orchestrator for Notion task lifecycle. Routes based on current task status.

## Input

Task reference: `$ARGUMENTS`

Accepts:
- **Notion URL** — full page URL
- **Task ID** — e.g., "TASK-42" or just "42"
- **Empty** — falls back to `/engineering:next` to pick a task

## Prerequisites

Load workspace context:

```
Read ~/.claude/skills/notion/workspace.md
```

## Workflow

### 1. Resolve Task

**If URL provided**: Extract page ID, fetch via `notion-researcher` agent (haiku).

**If Task ID provided**: Search Tasks database via `notion-researcher` for matching ID, then fetch.

**If empty**: Invoke `/engineering:next` and use the selected task. When `/engineering:next` completes with a selection, continue from Step 2 (Review Ticket) with that task's URL.

Extract from the fetched task:
- Title, Status, Priority, Estimate, Task type
- Page content (look for `## Plan`, `## Acceptance Criteria`, `## Scope` sections)
- Task ID (userDefined:ID)
- URL

### 2. Review Ticket

**Skip this step if the task was just planned in this session** (the user already knows what's in the task — re-confirming wastes time). Jump straight to Step 3.

Otherwise, present a concise summary for confirmation:

```
## {Title} ({Task ID})
**Status**: {status} | **Priority**: {priority} | **Estimate**: {estimate} | **Type**: {type}

### Description
{Summarize the page content — goal, key acceptance criteria, scope. Keep it to 5-8 lines max.}

### Key Details
- **Files in scope**: {list if available, or "Not specified"}
- **Dependencies**: {blocking/blocked-by tasks, or "None"}
- **Plan**: {exists / not yet planned}
```

Use `AskUserQuestion`:
- **Question**: "Does this look right? Any changes before we proceed?"
- **Header**: "Review"
- **Options**:
  - **Looks good** — "Proceed with this task as described"
  - **Update description** — "I want to refine the ticket first (opens discussion)"
  - **Pick another** — "This isn't what I want to work on"

- If **Looks good**: Continue to Step 3.
- If **Update description**: Discuss changes with the user. If Notion updates are needed, use `notion-writer` subagent (haiku) to apply them. Then re-present the summary and confirm.
- If **Pick another**: Invoke `/engineering:next`.

### 3. Route by Status

| Current Status | Action |
|---|---|
| **Not Started** | Go to Step 4 (Offer Planning) |
| **Ready** | Go to Step 5 (Set Up Workspace) |
| **In Progress** | Go to Step 6 (Resume) |
| **In Planning** | Go to Step 4 (Continue Planning) |
| **In Review** / **Needs Review** | Go to Step 8 (Finish) |
| **Done** / **Won't Do** | Report status and stop |
| **Later** | Ask: "This task is deferred. Move to Not Started and plan it, or pick another?" |

### 4. Offer Planning

Check if the task has a `## Plan` section in its Notion page content.

**If no plan exists**:
```
This task hasn't been planned yet. It needs grooming and an implementation plan.
```

Use `AskUserQuestion`:
- **Question**: "How would you like to proceed?"
- **Header**: "Planning"
- **Options**:
  - **Full planning** — "Run `/engineering:groom` for estimates, ACs, and implementation plan"
  - **Quick start** — "Skip planning, go straight to implementation (I know what to do)"
  - **Pick another** — "Go back to task selection"

- If **Full planning**: Invoke `/engineering:groom <task-url>`. When it completes, the task should be "Ready" — continue to Step 5.
- If **Quick start**: Continue to Step 5 directly.
- If **Pick another**: Invoke `/engineering:next`.

**If plan already exists** (In Planning status): Show the plan summary, ask if it's ready to execute. If yes, update status to "Ready" via `notion-writer` and continue to Step 5.

### 5. Set Up Workspace

**5a. Check for existing worktree**:

```bash
git worktree list
```

Look for a branch matching the task (e.g., `task-{id}-*` pattern). If found, ask whether to reuse it.

**5b. Create branch** (if no existing worktree/branch match):

Create and check out a branch in the current directory:
- Name format: `task-{id}-{slug}` where slug is the first 3-4 words of the title, kebab-cased
- Example: `git checkout -b task-42-add-vector-search`

No worktree creation — the user can launch Claude Code in a worktree or use `--worktree` if they want isolation.

**5c. Update Notion status**:

Spawn **`notion-writer`** subagent (haiku) to set status to "In Progress":

```
Update the Notion task at {task_url}.
Set status to "In progress".
Use mcp__claude_ai_Notion__notion-update-page.
```

### 6. Resume (In Progress)

The task is already in progress. Check for an existing worktree:

```bash
git worktree list
```

**If matching worktree found**: Report its location. If not already in the worktree, offer to switch:
```
Found existing worktree for this task at {path} on branch {branch}.
```

**If no worktree found**: The work may be on a branch in the main repo. Check:
```bash
git branch --list "task-{id}-*"
```

If a branch exists, check it out and continue. If no branch exists, follow Step 5b to ask about workspace isolation.

After resolving the workspace, continue to Step 7.

### 7. Execute

Present the execution approach based on what's available:

**If the task has a `## Plan` section** (from Notion or local `docs/plans/`):

Use `AskUserQuestion`:
- **Question**: "How would you like to execute?"
- **Header**: "Execute"
- **Options**:
  - **Batch execution** — "Use `/executing-plans` for step-by-step with review checkpoints"
  - **Subagent-driven** — "Use `/subagent-driven-development` for parallel task execution"
  - **Manual** — "I'll implement myself, just keep the task context loaded"

**If no plan**: Start implementing directly. The user chose "Quick start" in Step 4, so proceed with implementation based on the task description and acceptance criteria.

### 8. Finish

When implementation is complete (user signals done, or execution skill completes):

Invoke `/engineering:finish <task-url>` to handle:
- Git lifecycle (merge/PR/keep/discard via `/finishing-branch`)
- Notion status update
- Completion summary

## State Transitions

```
Resolved ──→ [Review Ticket] ──→ User confirms
Not Started ──→ [/engineering:groom] ──→ Ready
Ready ──→ [branch or worktree] ──→ In Progress
In Progress ──→ [implement] ──→ /engineering:finish
In Review ──→ [/engineering:finish] ──→ Done
/engineering:finish routes:
  merged ──→ Done
  pr-created ──→ In Review
  kept ──→ In Progress (unchanged)
  discarded ──→ Not Started
Later ──→ Not Started (manual) ──→ ...
```

## Edge Cases

- **Task is blocked**: Show what blocks it, offer to work on the blocker instead
- **Worktree already exists for different task**: Don't overwrite — create a new one with a unique name
- **No tests to run**: Skip test verification, note it in the finish summary
- **User wants to pause**: Keep worktree, keep status as "In Progress", report how to resume

## Notes

- This skill is the main entry point — it composes `/engineering:next`, `/engineering:new` (transitively via next), `/engineering:groom`, `/executing-plans`, and `/engineering:finish`
- Notion status updates happen via `notion-writer` subagent (haiku) to keep noise out
- Workspace context from `/notion-workspace` is loaded once and reused throughout
- The worktree name convention (`task-{id}-{slug}`) enables resume detection
