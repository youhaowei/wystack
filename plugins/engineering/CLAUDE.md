# Engineering Plugin

Development lifecycle roles — from requirements through shipped code.

## Agents

Five roles, each with a clear mandate. Invoke via the Agent tool.

| Agent | One job |
|-------|---------|
| **pm** | Requirements, user stories, prioritization, task management |
| **principal** | Architecture decisions, cross-project alignment, design reviews |
| **tech-lead** | Implementation planning and execution for a specific project |
| **qa** | Bug triage, testing, verification, coverage |
| **devops** | Git, CI/CD, releases, branch management, deployment |

## Skills (8)

Work lifecycle skills migrated from work-plugin. Agents load these as needed.

### PM
- `prd/` — behavior spec from user perspective
- `breakdown/` — PRD + spec to vertical-slice tickets
- `groom/` — codebase-aware task planning and estimation
- `next/` — prioritized task selection from Notion
- `new/` — codebase-informed task creation

### Principal
- `spec/` — technical specification with architecture and key decisions

### Tech Lead
- `start/` — full task lifecycle (Notion to shipped code)
- `groom/` — codebase-aware implementation planning (shared with PM)
- `finish/` — verify, merge/PR, cleanup

### QA & DevOps
These agents draw from general engineering knowledge and tools rather than specific skill files.

## The Cycle

```
PM: /prd → Principal: /spec → PM: /breakdown → PM: /groom → Tech Lead: /start → DevOps: /finish
```

Each step references what came before. Tickets ref PRD + spec. Review checks against stories.
