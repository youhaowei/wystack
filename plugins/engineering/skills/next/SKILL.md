---
name: next
description: Review Notion tasks for a project and recommend what to work on next. Pass a project name (e.g., "knowledgebase") or omit to auto-detect from the current directory.
---

# Next Task

Find the best task to work on next for a given project.

## Input

Project hint: `$ARGUMENTS`

If no argument provided, infer the project from the **current working directory name** (last path segment). Map common directory names to known projects — e.g., `knowledgebase` → Knowledgebase, `powker` → Powker, `workforce` → WorkForce. If no match is found, ask the user which project.

## Prerequisites

Load workspace context first (contains cached schemas and project URLs):

```
Read ~/.claude/skills/notion/workspace.md
```

## Workflow

### 1. Identify the Project

Using the Known Project URLs from the workspace skill, find the matching project URL and data source ID for the Tasks database.

### 2. Discover Tasks via Sub-agent

Spawn a **`notion-researcher`** agent (model: haiku) to do all Notion API work. This keeps verbose API responses out of the main context.

**Prompt the researcher with:**

```
Find actionable tasks for the {Project Name} project in Notion.

Tasks database data source: collection://24cd48cc-af54-8069-afc6-000b3ce9c348
Project page URL: {project_url}

Instructions:
1. Search the Tasks data source for "{Project Name}" tasks
2. From search results, fetch ONLY tasks that look actionable:
   - Skip tasks with titles starting with "Research:" (usually completed spikes)
   - Skip tasks that are clearly sub-tasks of epics (fetch the epic instead)
   - Prioritize recently edited tasks (more likely to be active)
   - Cap at 5 fetches maximum
3. For each fetched task, extract these properties:
   - Task ID (userDefined:ID), Title, Status, Priority, Estimate, Task type
   - Blocked by (relation URLs), Blocking (relation URLs)
   - Sub-tasks (if epic)
4. Return a structured summary:

READY (Status: Ready, not blocked — groomed and implementation-ready):
- TASK-{id}: {title} | {priority} | {estimate} | {type} | Blocks: {blocking count} | URL: {url}
  Brief: {first sentence of content or highlight}

NOT STARTED (Status: Not Started, not blocked — may need grooming):
- TASK-{id}: {title} | {priority} | {estimate} | {type} | Blocks: {blocking count} | URL: {url}
  Brief: {first sentence of content or highlight}

IN FLIGHT (Status: In progress, In Planning, In Review, Needs Review):
- TASK-{id}: {title} | {status} | URL: {url}

DEFERRED: {count} tasks (Status: Later, Won't Do, Done)

BLOCKED: (Status: Ready/Not Started but has incomplete Blocked by):
- TASK-{id}: {title} | Blocked by: TASK-{blocker_id} | URL: {url}

Notes on dependencies or soft blockers found in task descriptions.
```

### 3. Session Context Boost

Before ranking, check if the current conversation has relevant context that makes certain tasks more efficient to tackle now:

- **Scan the conversation history** for recently completed tasks, research spikes, or deep discussions about specific topics
- **Identify related tasks** — tasks spawned from the current session's work, tasks that share the same domain/module as what was just discussed, or tasks whose implementation was explored in conversation
- **Apply a context boost** — if a task is closely related to the current session's work, treat it as if it were one priority tier higher (e.g., Medium → High equivalent). The reasoning: the agent already has deep context that would be lost in a fresh session.

**Example**: If the session just completed a research spike on search algorithms and spawned a "Hybrid Search with RRF" task, that task gets a context boost because the agent understands the algorithm, the codebase locations, and the design decisions already.

**Important**: The context boost is a tiebreaker and soft signal, not an override. A Medium task with context boost should rank above other Medium tasks, but not necessarily above unrelated High tasks.

### 4. Rank and Present

From the researcher's summary, rank actionable tasks by:
1. **Status** (Ready > Not Started) — Ready means groomed and implementation-ready; Not Started hasn't been refined yet
2. **Priority** (Urgent > High > Medium > Low > Optional)
3. **Session context** — tasks related to current session's work get a boost (see Step 3)
4. **Estimate** (smaller first — prefer quick wins at same priority)
5. **Type** (Bug > Feature > Tech Debt > Research)
6. **Unblocking power** — prefer tasks that block other tasks

**Ready vs Not Started:** A High-priority Ready task always beats a High-priority Not Started task. Not Started tasks may still need grooming (acceptance criteria, scope definition) before implementation.

### 5. Present Choices with AskUserQuestion

Use `AskUserQuestion` with **markdown previews** so the user can compare tasks side-by-side and select directly. Present a brief context line before the question (in-flight count, deferred count).

Before the question, output a one-line summary:
```
## {Project Name} — Next Task
In Flight: {count} | Deferred: {count}
```

Then use `AskUserQuestion` with up to 4 options (top ranked tasks). Each option gets:
- **label**: `TASK-{id}: {title}` (keep short)
- **description**: `{priority} | {estimate} | {type} | {status}` + why it ranks here
- **markdown**: A preview card with full details:

```
TASK-{id}: {title}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:   {status}
Priority: {priority}
Estimate: {estimate}
Type:     {type}
Blocks:   {count} task(s)

{2-3 sentence summary of what this
task involves}

Why pick this:
{reasoning — unblocks others,
quick win, highest priority, etc.}

Notion: {url}
```

Add `(Recommended)` to the label of the top-ranked option.

**Question text**: `"Which task do you want to work on?"`
**Header**: `"Next task"`

### 6. Act on Selection

Based on the user's choice:

**If context is fresh** (early in conversation, low context usage):
- Invoke `/engineering:start <task-url>` to start the full lifecycle in the current session

**If context is heavy** (deep into a session, lots of prior work):
- Output a **kickstart prompt** the user can paste into a fresh session:
  ```
  **Kickstart prompt — copy into a new session:**

  > Implement TASK-{id}: {title}. Notion URL: {url}
  >
  > Context: {2-3 sentences of relevant context from this session — key files,
  > design decisions, algorithms discussed, anything that saves the next session
  > from re-discovering}. Use `/engineering:start` with the Notion URL above.
  ```
- The kickstart prompt should include **session-specific context** that would otherwise be lost — not just the task description (which is already in Notion), but insights, file paths, design decisions, or implementation approaches discussed in the current conversation.
- Tell the user to start a fresh session (`/clear` or new terminal) and paste the prompt.

**If they pick "Other"** → Ask what they'd like to do instead (plan/groom tasks via `/engineering:groom`, create new task via `/engineering:new`, etc.)

## Edge Cases

- **No actionable tasks**: Suggest reviewing deferred tasks or creating new ones via `/engineering:new`.
- **All tasks blocked**: Show the dependency chain and suggest tackling the blocker first.
- **New project (no tasks)**: Say so and offer to create tasks via `/engineering:new`.
- **Researcher returns insufficient data**: Fetch 1-2 more tasks directly rather than re-running the agent.

## Notes

- Use cached DB schema from workspace skill — never fetch schema at runtime
- The researcher agent handles ALL Notion API calls — main agent never calls notion-search/fetch directly
- If the project has an epic, the researcher should surface sub-tasks rather than the epic itself
- Total Notion API calls should be ~1 search + ~3-5 fetches (not 1 search + N fetches)
