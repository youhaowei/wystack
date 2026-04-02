# UX Writing

## Button Labels
Never "OK", "Submit", "Yes/No". Use verb + object:

| Bad | Good |
|-----|------|
| OK | Save changes |
| Submit | Create account |
| Yes | Delete message |
| Cancel | Keep editing |

Destructive actions: name the destruction. "Delete 5 items" not "Delete selected".

## Error Messages
Every error answers: (1) What happened? (2) Why? (3) How to fix?

| Situation | Template |
|-----------|----------|
| Format | "[Field] needs [format]. Example: [example]" |
| Missing | "Please enter [what's missing]" |
| Permission | "You don't have access to [thing]. [Alternative]" |
| Network | "Couldn't reach [thing]. Check connection and [action]" |
| Server | "Something went wrong on our end. [Alternative action]" |

Don't blame the user. "Please enter MM/DD/YYYY" not "You entered an invalid date."

## Empty States
Onboarding moments: acknowledge briefly → explain value → provide clear action. "No projects yet. Create your first one to get started."

## Voice vs Tone
Voice is consistent (brand personality). Tone adapts: celebratory for success, empathetic for errors, reassuring for loading, serious for destructive confirms. **Never humor for errors.**

## Accessibility
- Link text: standalone meaning ("View pricing plans" not "Click here")
- Alt text: describes information ("Revenue increased 40% in Q4" not "Chart")
- `alt=""` for decorative images
- Icon buttons need `aria-label`

## Translation
Plan for 30% text expansion (German, Finnish). Keep numbers separate. Full sentences as single strings. Avoid abbreviations. Build terminology glossary — one term per concept, enforced consistently.

## Consistency
Pick one and stick with it: Delete (not Remove/Trash), Settings (not Preferences/Options), Sign in (not Log in). Say it once, say it well — if the heading explains it, the intro is redundant.
