---
name: iterate
description: Figma iteration loop — modify code, push to Figma, screenshot, evaluate, refine. Closes the gap between code and design. Requires Figma plugin installed.
---

# Iterate

Iterative design loop using Figma as the visual canvas. The designer agent modifies code AND evaluates in Figma until converged.

## Prerequisites

- Figma plugin installed (provides MCP tools)
- Before any `use_figma` call, load the `figma:figma-use` skill
- Load `build/SKILL.md` for design principles
- Load `review/SKILL.md` for evaluation criteria

## The Loop

```
[1] Modify code
    ↓
[2] Push to Figma
    ↓
[3] Screenshot
    ↓
[4] Evaluate
    ↓
[5] Issues? → goto [1]  |  Clean? → document → done
```

### Step 1: Modify Code
Make targeted code changes. Edit source files directly.

### Step 2: Push to Figma
Choose based on context:

**From running app** (design matches live code):
- Use `figma:figma-generate-design` skill to capture the running page into Figma
- Best for full-page layouts and responsive testing

**From components** (building with design system):
- Load `figma:figma-use` skill first (mandatory)
- Use `use_figma` to build/update frames from published components and variables
- Use `search_design_system` to find reusable components

**From existing design** (iterating on a Figma file):
- Use `use_figma` to modify existing nodes directly

### Step 3: Screenshot
```
get_screenshot(fileKey, nodeId)
```
Capture the current Figma state for evaluation. Take multiple screenshots if evaluating responsive variants.

### Step 4: Evaluate
Apply the review/ skill criteria to the screenshot:
- AI slop check — does it look generic?
- Visual hierarchy — eye drawn to right elements?
- Spacing rhythm — consistent, intentional?
- Color usage — palette cohesive, contrast sufficient?
- Typography — hierarchy clear, readable?
- States — all interaction states represented?

**Be specific about issues.** "The CTA button competes with the nav bar" not "hierarchy needs work."

### Step 5: Decide
- **Issues found**: List specific code changes needed, return to Step 1
- **Converged**: Document the final state (screenshot + design decisions)
- **Stuck**: If 3+ iterations haven't resolved an issue, ask the user for direction

## Tips

- Start with structure (layout, hierarchy) before details (color, motion)
- Evaluate one dimension at a time to avoid overwhelm
- Screenshot at multiple breakpoints if responsive matters
- Compare against the original design intent, not just "does it look good"
- Use `get_design_context` to inspect specific node properties when debugging spacing/color issues

## Output

When iteration completes:
1. Final screenshot
2. Summary of design decisions made
3. Any compromises or known limitations
