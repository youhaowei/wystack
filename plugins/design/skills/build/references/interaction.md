# Interaction Design

## The Eight States
Every interactive element needs all states designed:

| State | Visual Treatment |
|-------|-----------------|
| Default | Base styling |
| Hover | Subtle lift, color shift (not touch) |
| Focus | Visible ring (`:focus-visible`, 2-3px, offset, 3:1 contrast) |
| Active | Pressed in, darker |
| Disabled | Reduced opacity, no pointer |
| Loading | Spinner, skeleton |
| Error | Red border, icon, message |
| Success | Green check, confirmation |

**Never `outline: none` without replacement.** Use `:focus-visible` for keyboard-only focus.

## Forms
- Placeholders aren't labels — always use visible `<label>`
- Validate on blur, not every keystroke (exception: password strength)
- Errors below fields with `aria-describedby`
- Every error: what happened + why + how to fix

## Loading States
Optimistic updates for low-stakes actions. Skeleton screens > spinners. Progressive loading > waiting for everything.

## Modals
Use native `<dialog>` element with `.showModal()`. For non-modal overlays, use the Popover API (`popover` attribute). Consider undo over confirmation dialogs — users click through confirmations mindlessly.

## Keyboard Navigation
Roving tabindex for component groups (tabs, menus, radio): one item tabbable, arrow keys move within. Skip links for keyboard users to jump past navigation.

## Gestures
Swipe/drag gestures are invisible. Always provide visible fallback. Hint at existence on first use.
