# Spatial Design

## Spacing System
Even pixels only. Use 4px base: 4, 8, 12, 16, 24, 32, 48, 64, 96px. Never odd pixel values (no 13px, 15px, etc.). Name tokens semantically (`--space-sm`, `--space-lg`), not by value. Use `gap` over margins for sibling spacing.

## Grids
`repeat(auto-fit, minmax(280px, 1fr))` for responsive grids without breakpoints. Named grid areas (`grid-template-areas`) for complex layouts, redefined at breakpoints.

## Visual Hierarchy

### The Squint Test
Blur your eyes at the screen. Can you identify: most important element, second most important, clear groupings? If everything looks same weight, hierarchy is broken.

### Hierarchy Through Multiple Dimensions
Don't rely on size alone. Combine 2-3:

| Tool | Strong | Weak |
|------|--------|------|
| Size | 3:1+ ratio | <2:1 |
| Weight | Bold vs Regular | Medium vs Regular |
| Color | High contrast | Similar tones |
| Position | Top/left | Bottom/right |
| Space | Surrounded by whitespace | Crowded |

### Cards Are Not Required
Use only when content is truly distinct and actionable, or items need visual comparison. Spacing and alignment create grouping naturally. **Never nest cards inside cards.**

## Container Queries
Viewport queries = page layouts. Container queries = components:
```css
.card-container { container-type: inline-size; }
@container (min-width: 400px) {
  .card { grid-template-columns: 120px 1fr; }
}
```

## Optical Adjustments
- Text at `margin-left: 0` looks indented — use `-0.05em` negative margin
- Geometrically centered icons look off-center — shift play icons right, arrows toward their direction
- Touch targets: 44px minimum, use pseudo-elements to expand tap area beyond visual size

## Depth
Semantic z-index scale (dropdown → sticky → modal-backdrop → modal → toast → tooltip). Consistent shadow elevation scale (sm → md → lg). Shadows should be subtle — if clearly visible, probably too strong.
