---
name: finish
description: "Notion-aware task finishing. Wraps /finishing-branch with Notion status updates and completion summaries. Pass a Notion task URL or omit to detect from current branch."
---

# Finish Task

Complete a task's lifecycle: git operations via `/finishing-branch`, then Notion status update and completion summary.

## Input

Task reference: `$ARGUMENTS`

- **Notion URL** → Use directly
- **Empty** → Detect from current branch name (expects `task-{id}-*` pattern)

## Prerequisites

Load workspace context:

```
Read ~/.claude/skills/notion/workspace.md
```

## Workflow

### 1. Resolve Task

**If URL provided**: Extract task URL for later Notion updates.

**If empty**: Detect from current branch:
```bash
git branch --show-current
```

If branch matches `task-{id}-*` pattern, extract the task ID and spawn **`notion-researcher`** (haiku) to search for the task by ID. If no match, ask the user for the Notion URL.

Fetch task details (title, status, URL) via `notion-researcher` if not already known.

### 2. Invoke /finishing-branch

Invoke `/finishing-branch` for git lifecycle handling:
- Tests verification
- Present options (merge, PR, keep, discard)
- Execute choice
- Worktree cleanup

**Wait for `/finishing-branch` to complete.** It will produce a structured outcome report:

```
## Outcome
Action: {merged | pr-created | kept | discarded}
Branch: {branch-name}
Base: {base-branch}
PR: {url or N/A}
Worktree: {cleaned | preserved | N/A}
```

### 3. Map Git Outcome to Notion Status

Based on the outcome from `/finishing-branch`:

| Git Outcome | Notion Status | Rationale |
|---|---|---|
| `merged` | **Done** | Work is on the base branch |
| `pr-created` | **In Review** | Awaiting review |
| `kept` | **In Progress** | Branch preserved, not finished |
| `discarded` | **Not Started** | Work was thrown away |

### 4. Update Notion

Spawn **`notion-writer`** subagent (haiku) to:

**a) Update task status** to the mapped value from Step 3.

**b) Append completion summary** to the task page:

```
## Completion Summary

**Date**: {today}
**Action**: {merged locally | PR created | kept for later | discarded}
**Branch**: `{branch-name}`
**Base**: `{base-branch}`
{**PR**: [{pr-url}]({pr-url}) — if applicable}

### Changes
{summary of commits — use `git log --oneline {base}..HEAD` output}

### Files Changed
{list from `git diff --stat {base}..HEAD`}
```

**If discarded**: Write a brief note explaining why (if the user provided a reason during `/finishing-branch`).

### 5. Report and Suggest Next

```
### Task Finished

TASK-{id}: {title}
Status: {old} → {new}
{PR: {url} — if applicable}

Notion updated with completion summary.
```

Use `AskUserQuestion`:
- **Question**: "What's next?"
- **Header**: "Next"
- **Options**:
  - **Next task** — "Run `/engineering:next` to pick another task"
  - **Retro** — "Run `/retro` to review this session's workflow"
  - **Done** — "I'm done for now"

## Edge Cases

- **No branch name match**: Ask the user for the Notion URL directly
- **Multiple tasks in branch name**: Use the first ID found, confirm with user
- **Task already Done**: Warn and ask if they still want to run `/finishing-branch`
- **/finishing-branch not available**: Fall back to manual git operations (merge/PR/keep/discard) with the same option presentation
- **Discarded work on a Not Started task**: Don't change status (already Not Started)

## Notes

- This skill is the counterpart to `/engineering:start` — one starts the lifecycle, this one finishes it
- `/finishing-branch` handles ALL git operations — this skill only adds the Notion layer
- The completion summary in Notion creates a permanent record of what was done
- Branch name convention `task-{id}-*` enables automatic task detection
