# WyStack Plugins

Private marketplace of agent role definitions, skills, and tools.

Each subdirectory is an independently installable plugin containing domain-specific
agent roles and the knowledge they need. While currently packaged for Claude Code,
the definitions are harness-agnostic — agent roles, skills, and MCP tools can be
consumed by any compatible harness (Claude Code, Codex, OpenCode, etc.).

## Plugins

| Plugin | Purpose |
|--------|---------|
| `engineering/` | Development lifecycle — PM, principal, tech lead, QA, devops |
| `marketing/` | Growth & content — strategy, copy, SEO, CRO, acquisition, analytics |

## Install (Claude Code)

Add as a local plugin source pointing to the specific plugin directory:

```json
{
  "type": "local",
  "path": "/path/to/wystack/plugins/marketing"
}
```

Or register the entire `plugins/` directory as a marketplace.
