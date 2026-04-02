---
name: new
description: Create a new task in the Notion Tasks database. Codebase-aware — explores relevant files to auto-suggest estimates and scope. Pass a description or omit for interactive mode.
---

# New Task

Create a codebase-informed task in Notion with estimates, acceptance criteria, and scope.

## Input

Task description: `$ARGUMENTS`

If no argument, use `AskUserQuestion` to ask what needs to be done.

## Prerequisites

Load these into YOUR context (needed for orchestration):

```
Read ~/.claude/skills/notion/workspace.md
Read ~/.claude/skills/estimation/SKILL.md
```

## Architecture

| Concern | Where | Why |
|---------|-------|-----|
| Orchestration, user interaction | **Main Opus** | Needs conversation history |
| Codebase exploration | **`Explore` subagent** | File contents stay out |
| Notion writes | **`notion-writer` subagent** | Confirmation noise stays out |

## Workflow

### 1. Gather Description

If `$ARGUMENTS` is empty, ask via `AskUserQuestion`:
- **Question**: "What needs to be done?"
- **Header**: "New task"
- **Options**:
  - **Bug** — "Something is broken or behaving incorrectly"
  - **Feature** — "New functionality or enhancement"
  - **Tech Debt** — "Refactoring, cleanup, or infrastructure improvement"
  - **Research** — "Investigate an approach, library, or design question"

After selection, ask for a brief description of the work.

### 2. Identify Project

Infer from the **current working directory name** (last path segment). Map common directory names to known projects — e.g., `knowledgebase` → Knowledgebase, `powker` → Powker, `workforce` → WorkForce.

If no match, ask the user which project.

### 3. Explore Codebase

Spawn an **`Explore` subagent** to analyze codebase impact. Prompt:

```
Task: "{description}"
Project: {project_name}

Analyze:
1. **Affected files** — paths + brief rationale
2. **Implementation complexity** — files changed, new vs existing patterns
3. **Suggested estimate** — use scale (XS/S/M/L/XL/XXL) with reasoning:
   - XS: Single-file, <20 lines, pattern-following
   - S: 1-2 files, <50 lines, straightforward
   - M: 2-4 files, new logic, minor design decisions
   - L: 4-8 files, architectural decisions, multiple modules
   - XL: 8+ files, cross-cutting, needs spec
   - XXL: Split first
4. **Suggested acceptance criteria** — concrete, testable, referencing actual file paths
5. **Potential blockers** — dependencies, unknowns, prerequisites

Exploration depth: "quick" for likely S/M, "medium" for likely L+.
```

### 4. Present Task Proposal

Synthesize the exploration results and present to the user:

```
### New Task Proposal

**Title**: {suggested title}
**Type**: {type}
**Priority**: {suggested — Medium unless clearly urgent}
**Estimate**: {size} ({model tier})

**Description**:
{refined description based on codebase analysis}

**Acceptance Criteria**:
1. {criterion referencing code}
2. {test criterion}
3. {doc criterion if M+}

**Affected Files**: {list}
```

Use `AskUserQuestion` for confirmation:
- **Question**: "Create this task?"
- **Header**: "Confirm"
- **Options**:
  - **Create as-is** — "Create with the suggested properties"
  - **Edit first** — "I want to change some details"
  - **Cancel** — "Don't create"

If "Edit first": ask what to change, update, and re-present.

### 5. Create in Notion

Spawn **`notion-writer`** subagent to create the task:

```
Create a task in the Notion Tasks database.

Tasks database data source: collection://24cd48cc-af54-8069-afc6-000b3ce9c348

Properties:
- Task name: "{title}"
- Status: "Not Started"
- Priority: "{priority}"
- Estimates: "{estimate}"
- Task type: "{type}"
- Project: ["{project_url}"]

Page content:
## Description
{description}

## Acceptance Criteria
{numbered list}

## Scope
- Files: {affected files}
- Tests: {required per estimation tier}
- Docs: {required per estimation tier}
```

### 6. Offer Next Steps

After creation, present options:

```
Task created: TASK-{id} — {title}
Notion: {url}
```

Use `AskUserQuestion`:
- **Question**: "What's next?"
- **Header**: "Next step"
- **Options**:
  - **Plan it** — "Run `/engineering:groom` to create implementation plan"
  - **Start working** — "Run `/engineering:start` to begin implementation"
  - **Done** — "I'll come back to it later"

## Edge Cases

- **Duplicate detection**: Before creating, mention if similar-sounding tasks exist in the project (check researcher results if available from recent `/engineering:next` run)
- **XXL estimate**: Suggest splitting into sub-tasks before creating
- **Research type**: Default status to "Later" per workspace conventions

## Notes

- Uses cached DB schema from workspace skill — never fetch schema at runtime
- Exploration keeps file contents out of main context
- The notion-writer handles all Notion API calls
