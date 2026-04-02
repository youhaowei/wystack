---
name: distill
description: Simplify by removing unnecessary complexity. Ruthless reduction to essential elements. Requires context about users and goals before proceeding.
---

# Distill

Remove complexity to reveal essence. Simplicity ≠ removing features — it's removing obstacles between users and goals.

## Context Gate

**STOP before simplifying.** You need:
- Target audience and their context
- Primary user goal (there should be ONE)
- What's essential vs nice-to-have

Attempt to infer from codebase. If confidence is medium or lower, ask the user. Simplifying the wrong things destroys usability.

## Assess Complexity Sources
- Too many elements competing for attention
- Excessive variation (colors, fonts, sizes) without purpose
- Information overload — everything visible at once
- Visual noise — unnecessary borders, shadows, decorations
- Feature creep — too many options or paths
- Unclear hierarchy — nothing stands out

## Simplify Across Dimensions

### Information Architecture
- ONE primary action, few secondary, everything else hidden
- Progressive disclosure — hide complexity behind clear entry points
- Combine related actions, remove redundancy
- If it's said elsewhere, don't repeat it

### Visual
- 1-2 colors + neutrals, not 5-7
- One font family, 3-4 sizes, 2-3 weights
- Remove decorations that don't serve hierarchy
- Flatten nesting, remove unnecessary containers/cards

### Layout
- Linear flow over complex grids where possible
- Move secondary content inline or hide it
- Generous whitespace — let content breathe

### Interaction
- Fewer buttons, clearer path forward
- Smart defaults — only ask when necessary
- Inline actions over modal flows
- Reduce steps

### Content
- Cut every sentence in half, then again
- Active voice, plain language
- Essential information only — no marketing fluff
- Say it once, say it well

## Guardrails
Never:
- Remove necessary functionality
- Sacrifice accessibility (labels, ARIA still required)
- Make things so simple they're unclear
- Remove information users need for decisions
- Oversimplify complex domains

## Verify
- Faster task completion?
- Reduced cognitive load?
- All necessary features still accessible?
- Clearer hierarchy?
