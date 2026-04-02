# Responsive Design

## Mobile-First
Base styles for mobile, `min-width` queries to layer complexity. Desktop-first means mobile loads unnecessary styles.

## Breakpoints
Content-driven, not device-driven. Start narrow, stretch until design breaks, add breakpoint. Three usually suffice (~640, 768, 1024px). Use `clamp()` for fluid values without breakpoints.

## Input Detection
Screen size ≠ input method. Use pointer/hover queries:
```css
@media (pointer: coarse) { .button { padding: 12px 20px; } }  /* touch */
@media (pointer: fine) { .button { padding: 8px 16px; } }     /* mouse */
@media (hover: none) { /* no hover states — use active */ }
```
Never rely on hover for functionality.

## Safe Areas
```css
body { padding: max(1rem, env(safe-area-inset-bottom)); }
```
Enable with `<meta name="viewport" content="..., viewport-fit=cover">`.

## Responsive Images
```html
<img src="hero-800.jpg"
  srcset="hero-400.jpg 400w, hero-800.jpg 800w, hero-1200.jpg 1200w"
  sizes="(max-width: 768px) 100vw, 50vw" alt="...">
```
`<picture>` for art direction (different crops, not just resolutions).

## Layout Patterns
- Navigation: hamburger → horizontal compact → full with labels
- Tables: transform to cards on mobile
- Progressive disclosure: `<details>/<summary>` for collapsible content

## Testing
DevTools misses real touch, CPU constraints, network latency, font rendering. Test on at least one real iPhone + one real Android.
