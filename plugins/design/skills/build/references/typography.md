# Typography

## Vertical Rhythm
Line-height is the base unit for ALL vertical spacing. Body `line-height: 1.5` on 16px = 24px base. All spacing multiples of that.

## Modular Scale
Use fewer sizes with more contrast. 5-size system covers most needs:

| Role | Size | Use |
|------|------|-----|
| xs | 0.75rem | Captions, legal |
| sm | 0.875rem | Secondary UI, metadata |
| base | 1rem | Body text |
| lg | 1.25-1.5rem | Subheadings, lead |
| xl+ | 2-4rem | Headlines, hero |

Ratios: 1.25 (major third), 1.333 (perfect fourth), 1.5 (perfect fifth). Pick one, commit.

## Readability
`max-width: 65ch` for measure. Line-height scales inversely with line length. Increase line-height +0.05-0.1 for light-on-dark text.

## Font Selection

**Better alternatives to overused fonts:**
- Inter → Instrument Sans, Plus Jakarta Sans, Outfit
- Roboto → Onest, Figtree, Urbanist
- Open Sans → Source Sans 3, Nunito Sans, DM Sans
- Editorial → Fraunces, Newsreader, Lora

System fonts are underrated for apps where performance > personality.

**Pairing**: You often don't need a second font. One family in multiple weights > two competing typefaces. When pairing, contrast on multiple axes (serif + sans, geometric + humanist, condensed + wide). Never pair similar-but-not-identical fonts.

## Web Font Loading
```css
@font-face {
  font-family: 'CustomFont';
  src: url('font.woff2') format('woff2');
  font-display: swap;
}
```
Match fallback metrics (`size-adjust`, `ascent-override`, `descent-override`) to minimize layout shift.

## Fluid Type
`clamp(min, preferred, max)` — middle value controls scaling rate. Add rem offset so it doesn't collapse to 0. Don't use for button text, labels, or UI elements.

## OpenType Features
```css
.data-table { font-variant-numeric: tabular-nums; }
.recipe { font-variant-numeric: diagonal-fractions; }
abbr { font-variant-caps: all-small-caps; }
code { font-variant-ligatures: none; }
```

## Tokens
Name semantically (`--text-body`, `--text-heading`), not by value.

## Accessibility
- Never `user-scalable=no`
- rem/em for font sizes, never px for body
- Minimum 16px body text
- 44px+ tap targets for text links
