---
name: workspace
description: Notion workspace context — cached database schemas, project URLs, and conventions. Load before any Notion operation. No runtime discovery needed.
---

# Notion Workspace Context

Cached schemas and conventions for all Notion operations. **Never fetch schemas at runtime** — everything is here.

## Tasks Database

Data source: `collection://24cd48cc-af54-8069-afc6-000b3ce9c348`

| Property | Type | Values |
|----------|------|--------|
| Task name | title | — |
| Status | status | Not Started, Ready, Later, Needs Review, In progress, In Planning, In Review, Done, Won't Do |
| Priority | select | Optional, Low, Medium, High, Urgent |
| Task type | select | Research, Bug, Feature, Tech Debt, Epic, writing, Task |
| Estimates | select | ?, XS, S, M, L, XL, XXL |
| Tags | multi_select | UI, Design System, Refactor, Zustand Store, Enhancement, Connector, Auto Claude, Performance, Code Quality, WorkForce Sessions, WorkForce Fork |
| Project | relation | **Required** — use Known Project URLs below |
| Parent | relation | Parent task URL (for sub-tasks) |
| Sub-tasks | relation | Auto-populated from Parent |
| Blocked by | relation | Blocking task URLs |
| Blocking | relation | Auto-populated from Blocked by |
| Derived from | relation | Research/spike that informed this task |
| Due | date | `date:Due:start` format |
| Start Date | date | `date:Start Date:start` format |
| Timeline | date range | `date:Timeline:start` + `date:Timeline:end` |
| Assignee | person | JSON array of user IDs |
| ID | userDefined | Auto-generated task number |

## Projects Database

Data source: `collection://24cd48cc-af54-80d7-b03a-000b6e1a540b`

| Property | Type | Values |
|----------|------|--------|
| Project name | title | — |
| Status | select | Focused, On Hold, Planning, Archived, Watching, Not Started |
| Tech Stack | multi_select | TypeScript, React, SolidJS, Tauri, Bun, SwiftUI, Next.js, Convex, DuckDB, Notion API, AI Vision |
| Repository | url | GitHub repo URL |
| Description | text | — |

## Known Project URLs

| Project | URL |
|---------|-----|
| Knowledgebase | `https://www.notion.so/30cd48ccaf5481889ae3f9238c4295d3` |
| Powker | `https://www.notion.so/24cd48ccaf5480de8a2dee274b0cf1fb` |
| WorkForce | `https://www.notion.so/2ffd48ccaf5481d7bb33d67599423042` |
| unifai | `https://www.notion.so/30fd48ccaf54811199abf0b639497be0` |
| WyStack | `https://www.notion.so/320d48ccaf5481968bf3e3e1580a6f6d` |

## Project Detection

Map working directory name → project:

| Directory | Project |
|-----------|---------|
| workforce | WorkForce |
| knowledgebase | Knowledgebase |
| powker | Powker |
| unifai | unifai |
| wystack | WyStack |

## Conventions

- **Every task MUST have a Project relation** — no orphan tasks
- **Batch-create** — epic first, then sub-tasks in one `notion-create-pages` call (up to 100)
- **Search before create** — check for duplicates
- **Defaults**: Features → Not Started + Enhancement tag. Bugs → Not Started. Research → Later. Tech Debt → Later + Refactor tag.
- **Use `mcp__claude_ai_Notion__*` tools only** — not `mcp__plugin_Notion_notion__*`

## Status Lifecycle

```
Not Started → Ready (groomed, has ACs)
Not Started → In Planning (being scoped)
Ready → In progress (work started)
In progress → In Review / Needs Review (PR up)
In Review → Done (merged)
Any → Won't Do (cancelled)
Any → Later (deferred)
```

## Tools

Load via ToolSearch before first use:
- `mcp__claude_ai_Notion__notion-search` — search workspace
- `mcp__claude_ai_Notion__notion-fetch` — fetch page/database details
- `mcp__claude_ai_Notion__notion-create-pages` — create pages or database rows
- `mcp__claude_ai_Notion__notion-update-page` — update page properties or content
