---
name: build
description: Create distinctive, production-grade frontend interfaces. Design principles, anti-patterns, and aesthetic direction. Load before any design work.
---

# Build

Guide for creating distinctive frontend interfaces that avoid generic AI aesthetics.

## Design Direction

Commit to a **bold aesthetic direction** before writing code:
- **Purpose**: What problem? Who uses it?
- **Tone**: Pick an extreme — brutally minimal, maximalist, retro-futuristic, organic, luxury, playful, editorial, brutalist, art deco, soft/pastel, industrial. There are many flavors. Be specific.
- **Differentiation**: What's the one thing someone will remember?

Bold maximalism and refined minimalism both work — the key is intentionality, not intensity.

## Anti-Patterns (The AI Slop Test)

If you showed this interface to someone and said "AI made this," would they believe you immediately? If yes, redesign.

### Typography
- **DO**: Modular type scale with fluid sizing (`clamp`). Vary weights/sizes for hierarchy.
- **DON'T**: Inter, Roboto, Arial, Open Sans, system defaults. Monospace as lazy "developer" vibes. Large rounded-corner icons above every heading.

### Color
- **DO**: OKLCH for perceptually uniform palettes. Tint neutrals toward brand hue. Dominant + sharp accents.
- **DON'T**: Cyan-on-dark, purple-to-blue gradients, neon accents on dark. Gradient text for "impact." Pure black/white. Gray text on colored backgrounds. Default to dark mode with glowing accents.

### Layout
- **DO**: Visual rhythm through varied spacing. Asymmetry. Break the grid intentionally. Fluid spacing with `clamp()`.
- **DON'T**: Cards around everything. Nested cards. Identical card grids. Hero metric layout template. Center everything. Same spacing everywhere.

### Visual Details
- **DO**: Intentional decorative elements that reinforce brand.
- **DON'T**: Glassmorphism everywhere. Thick colored border on one side. Decorative sparklines. Rounded rectangles with generic shadows. Modals unless truly necessary.

### Motion
- **DO**: Exponential easing (ease-out-quart/quint/expo). Staggered page-load reveals. `grid-template-rows` for height animations.
- **DON'T**: Bounce or elastic easing. Animate layout properties (width/height/padding). Animation for its own sake.

### Interaction
- **DO**: Progressive disclosure. Empty states that teach. Every interactive surface responsive.
- **DON'T**: Redundant information. Every button primary. Missing hover/focus/active/disabled states.

### Responsive
- **DO**: Container queries for components. Adapt for different contexts.
- **DON'T**: Hide critical functionality on mobile. Desktop-first design.

## References

Detailed guidance for each dimension:
- [Typography](references/typography.md) — scales, pairing, loading
- [Color](references/color.md) — OKLCH, palettes, dark mode, contrast
- [Spatial](references/spatial.md) — grids, rhythm, container queries, hierarchy
- [Motion](references/motion.md) — timing, easing, reduced motion, perceived performance
- [Interaction](references/interaction.md) — states, focus, forms, keyboard, modals
- [Responsive](references/responsive.md) — mobile-first, fluid, input detection
- [UX Writing](references/ux-writing.md) — labels, errors, empty states, voice

## Implementation

Match complexity to aesthetic vision. Maximalist = elaborate animations/effects. Minimalist = precision in spacing, typography, subtle details.

Interpret creatively. No two designs should be the same. Vary themes, fonts, aesthetics. Never converge on common choices.
