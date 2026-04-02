---
name: setup
description: One-time project design context setup. Scans codebase for design signals, asks targeted questions, writes Design Context section to CLAUDE.md.
---

# Design Setup

One-time setup that establishes persistent design guidelines for a project.

## Step 1: Scan Codebase

Before asking questions, discover what you can:
- README/docs — project purpose, target audience
- Package.json — tech stack, design libraries
- Existing components — current patterns, spacing, typography
- CSS variables / design tokens — color palettes, font stacks, spacing scales
- Brand assets — logos, favicons, defined colors
- Existing CLAUDE.md — any design context already written

Note what you learned and what remains unclear.

## Step 2: Ask (Only What's Missing)

Use `AskUserQuestion` for what couldn't be inferred:

**Users & Purpose**
- Who uses this? Context when using it?
- Primary job to be done?
- Emotions the interface should evoke?

**Brand & Personality**
- Brand personality in 3 words?
- Reference sites/apps that capture the right feel? What specifically?
- Anti-references — what should this NOT look like?

**Aesthetic Direction**
- Visual direction preference? (minimal, bold, elegant, playful, technical, organic)
- Light mode, dark mode, or both?
- Colors that must be used or avoided?

**Accessibility**
- Specific requirements? (WCAG level, known user needs)
- Reduced motion, color blindness considerations?

Skip questions already answered by the codebase.

## Step 3: Write Design Context

Synthesize into a `## Design Context` section and append/update in the project's CLAUDE.md:

```markdown
## Design Context

### Users
[Who, context, job to be done]

### Brand Personality
[Voice, tone, 3-word personality, emotional goals]

### Aesthetic Direction
[Visual tone, references, anti-references, theme preference]

### Design Principles
[3-5 principles derived from the conversation]
```

Confirm what was written and summarize the key principles.