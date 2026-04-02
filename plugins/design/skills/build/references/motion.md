# Motion Design

## Duration

| Duration | Use | Examples |
|----------|-----|---------|
| 100-150ms | Instant feedback | Button press, toggle, color change |
| 200-300ms | State changes | Menu open, tooltip, hover |
| 300-500ms | Layout changes | Accordion, modal, drawer |
| 500-800ms | Entrances | Page load, hero reveals |

Exit animations: ~75% of enter duration.

## Easing
Don't use `ease`. Use exponential curves for natural deceleration:

```css
--ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);   /* smooth, refined (default) */
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);     /* snappy, confident */
```

| Curve | Use |
|-------|-----|
| ease-out | Elements entering |
| ease-in | Elements leaving |
| ease-in-out | State toggles |

**Never bounce or elastic** — dated, tacky. Real objects decelerate smoothly.

## Only Animate Transform + Opacity
Everything else causes layout recalculation. For height: `grid-template-rows: 0fr → 1fr`.

## Staggered Animations
`animation-delay: calc(var(--i, 0) * 50ms)` with `style="--i: 0"` per item. Cap total stagger time — 10 items × 50ms = 500ms max.

## Reduced Motion (Required)
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```
Preserve functional animations (progress bars, spinners) — just remove spatial movement.

## Perceived Performance
80ms threshold — anything under feels instant. Optimistic UI: update immediately, sync later (for low-stakes actions). Skeleton screens > spinners. Ease-in toward completion compresses perceived time.

## Performance
`will-change` only when animation is imminent (`:hover`, `.animating`). Intersection Observer for scroll-triggered animations — unobserve after animating once.
