# Color & Contrast

## Color Space
Prefer OKLCH — perceptually uniform (equal lightness steps look equal, unlike HSL). Fall back to HSL if project constraints require it.

```css
/* OKLCH: lightness (0-100%), chroma (0-0.4+), hue (0-360) */
--color-primary: oklch(60% 0.15 250);
--color-primary-light: oklch(85% 0.08 250);  /* reduce chroma at extremes */
--color-primary-dark: oklch(35% 0.12 250);
```

Key: reduce chroma toward white/black. High chroma at extreme lightness looks garish.

## Tinted Neutrals
Pure gray is dead. Add brand hue at minimal saturation:
```css
/* OKLCH */
--gray-100: oklch(95% 0.01 250);
--gray-900: oklch(15% 0.01 250);

/* HSL equivalent */
--gray-100: hsl(220 10% 95%);
--gray-900: hsl(220 10% 15%);
```

## Palette Structure

| Role | Purpose |
|------|---------|
| Primary | Brand, CTAs, key actions — 1 color, 3-5 shades |
| Neutral | Text, backgrounds, borders — 9-11 shades |
| Semantic | Success, error, warning, info — 4 colors, 2-3 shades each |
| Surface | Cards, modals, overlays — 2-3 elevation levels |

Skip secondary/tertiary unless needed. One accent color is enough for most apps.

## 60-30-10 Rule
60% neutral backgrounds/whitespace, 30% secondary (text, borders), 10% accent (CTAs, highlights). Overusing accent kills its power.

## WCAG Contrast

| Content | AA | AAA |
|---------|-----|-----|
| Body text | 4.5:1 | 7:1 |
| Large text (18px+) | 3:1 | 4.5:1 |
| UI components | 3:1 | 4.5:1 |

Placeholder text still needs 4.5:1. Gray on colored backgrounds looks washed — use a darker shade of the background instead.

## Dark Mode
Not inverted light mode. Different design decisions:
- Depth via lighter surfaces, not shadows
- Desaturate accents slightly
- Reduce font weight (~350 vs 400)
- Never pure black — use 12-18% lightness with tinted neutrals

Use two-layer tokens: primitives (`--blue-500`) + semantic (`--color-primary`). Dark mode redefines only semantic layer.

## Alpha Is a Smell
Heavy transparency = incomplete palette. Define explicit overlay colors per context. Exception: focus rings and interactive states.
