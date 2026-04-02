---
name: review
description: Evaluate design quality — AI slop detection, visual hierarchy, accessibility, performance. Structured findings with severity and actionable fixes.
---

# Design Review

Evaluate an interface as a design director would. Produces structured findings, not fixes.

## Prerequisites

Load `build/SKILL.md` for design principles and anti-patterns before evaluating.

## Evaluation Dimensions

### 1. AI Slop Detection (First)
Check against ALL anti-patterns in build/SKILL.md. Would someone immediately believe "AI made this"? List specific tells.

### 2. Visual Hierarchy
- Eye flows to most important element first?
- Clear primary action visible in 2 seconds?
- Size, color, position communicate importance correctly?
- No visual competition between elements of different weight?

### 3. Information Architecture
- Structure intuitive for new users?
- Related content grouped logically?
- Cognitive overload? Too many choices at once?

### 4. Emotional Resonance
- What emotion does this evoke? Is that intentional?
- Would target user feel "this is for me"?

### 5. Composition & Typography
- Layout balanced or uncomfortably weighted?
- Whitespace intentional or leftover?
- Type hierarchy signals read order clearly?
- Font choices reinforce brand/tone?

### 6. Color & Contrast
- Color communicates, not just decorates?
- Palette cohesive? Accent draws attention to right things?
- All text meets WCAG AA (4.5:1 body, 3:1 large)?
- Works for colorblind users?

### 7. Interaction States
- All 8 states designed? (default, hover, focus, active, disabled, loading, error, success)
- Empty states guide users toward action?
- Error states helpful and non-blaming?

### 8. Accessibility
- Semantic HTML, proper heading hierarchy, landmarks?
- Keyboard navigation, focus indicators, tab order?
- ARIA labels on interactive elements?
- Touch targets 44px+?

### 9. Performance
- Layout properties animated? (should be transform/opacity only)
- Images lazy loaded? Appropriate formats?
- Layout shift on load?
- `prefers-reduced-motion` respected?

### 10. Responsive
- Works at mobile/tablet/desktop?
- No horizontal scroll?
- Content adapts, not just shrinks?

## Output Format

### Anti-Patterns Verdict
Pass/fail. List specific tells. Be brutally honest.

### Overall Impression
Gut reaction — what works, biggest opportunity. 2-3 sentences.

### What's Working
2-3 specific strengths with reasoning.

### Priority Issues (3-5 max)
For each:
- **What**: Name the problem
- **Why**: How it hurts users
- **Fix**: Concrete action
- **Severity**: Critical / High / Medium / Low

### Minor Observations
Quick notes on smaller issues.

## Principles
- Direct — vague feedback wastes time
- Specific — "the submit button" not "some elements"
- Prioritized — if everything is important, nothing is
- Actionable — concrete suggestions, not "consider exploring..."
