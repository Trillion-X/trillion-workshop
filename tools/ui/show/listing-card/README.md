# listing-card

The one glance shape: a thing (a tool, an app, a space, a notice, a step) drawn as a summary a person reads at a glance instead of a list of labelled fields, as a card or a one-line row, and the grid that lays any number of them out.

The shape, from the visual-hierarchy sheets the owner picked on 2026-10-01: the thing's icon, face or logo leads; its name is the title; when it happened sits muted under it; the one value that matters stands alone on the right, big, with its unit small (`$437` `/night`); everything else is icon-led facts in one row and chips (people with their faces, companies with their logos, things with their kind's icon, field chips that open into their details); state is a tinted lead tile or a coloured dot, never words. Every field is DATA and optional.

## Files

| File | Purpose |
|------|---------|
| `ListingCard.tsx` | `ListingCard` (lead icon or face with its tone, name, who made it and when muted under it, the key value and its unit on the right, a dot mark, two lines of what it does, chips with faces and field chips, icon-led facts in one row, a corner badge, a toned signal line; optionally a cover band with its picture and the icon over its edge, the people in it as an avatar group, and its own buttons; opened as a whole or answered by its buttons; a `card` or a one-line `row` form) and `ListingGrid` (as many columns of at least 16rem as fit, one on a phone; a row spans the whole width). |
| `index.ts` | The one import point. |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `Listing` | `{ id, title, form?: 'card' \| 'row', byline?, when?, text?, icon?, picture?, tone?, mark?: ListingTone, value?, unit?, valueLabel?, badge?: ListingTone, facts?: ListingFact[], chips?: ListingChip[], factChips?: ListingFactChips, signal?: ListingTone, cover?: ListingCover, people?: AvatarGroupItem[], peopleLabel?, actions?: ListingAction[], progress?: number \| null, face?: ListingFace, whole?: boolean, logo? }` | One thing, as DATA. `icon` is a NamedIcon name; `picture` is its face or logo in the lead tile; `logo` is a provider-icon slug (x, youtube, substack) whose shipped mark leads in place of the icon when the registry knows it; `tone` tints that tile; `mark` is a dot whose words show on hover; `value` with its small `unit` stands alone on the right; `progress` (0 to 1, or null while not known) is work still going on, drawn on the lead tile; `face` is who is doing it, leading in place of the icon; `whole` makes a row show its full title with when and the note on one quiet line under it. |
| `ListingFace` | `{ name, picture?, provider?, working? }` | Who is doing it: the provider's mark when the shipped registry knows `provider`, else `picture`, else initials (person-tag `md`); `working` runs a short blue line around the face's edge. |
| `ListingChip` | `{ label, picture?, kind?, value?, icon?, colour?, href?, tone?, arrow? }` | A name drawn as a chip: with `kind` a `record-chip` (the kind's icon and colour); with `tone` and no kind a state, a pill in that tone's colour; otherwise a `person-tag` with its face or logo (initials until it has one). `arrow` draws an arrow before the chip, so a change of state reads `chip -> chip`. |
| `ListingFactChips` | `{ fields, facts, valueLabels?, valueIcons?, label? }` | Field chips drawn by `fact-chips`, each opening on hover into its details. |
| `ListingCover` | `{ picture?: string \| null; letters?: string; colour?: string \| null; page?: string[] }` | The band across the top: the picture, or a quiet fill with `letters` set large in it until there is one; a picture that fails to load falls back to the fill. `page` is the thing's own opening lines as it reads (a draft, a document, a script): a sheet rising out of the band, the first line its heading, fading at the foot; the tile then sits beside the title instead of over the band. `colour` is a palette id the fill and letters wear (`data-colour`, painted by `screen-look/show/listing-card.css` from the `--record-kind-<id>` hues). |
| `ListingAction` | `{ id, label, icon?, primary? }` | A button on a card answered rather than opened (Join, Decline, Do this for me). |
| `ListingFact` | `{ label, value, icon? }` | A fact led by its icon; the label is read aloud and shown on hover, never drawn; facts sit in one wrapping row. |
| `ListingTone` | `{ label, tone? }` | Words with a plain tone word: good, attention, bad, info, quiet (`coss/ui/badge` `badgeVariantForTone`). |
| `ListingCard` | `({ listing, onOpen?, onAction?, content?, controls?, className? }) => JSX` | One card or row; with `onOpen` a press, Enter or Space opens it; with `listing.actions` each button reports `onAction(listing.id, action.id)`; caller `content` sits after the short description and before chips/facts, while `controls` stay after the card's buttons. |
| `ListingGrid` | `({ listings, onOpen?, onAction?, controls?, label, className? }) => JSX` | A labelled list of cards in a grid; `controls(listing)` draws the caller's own controls on each one (a Take out button), as `ListingCard` `controls`. |

## Invariants

- Blind: no kind of listing, maker, place or state is named here; every word, icon and tone is the caller's DATA.
- With `onOpen` a press anywhere on the card opens its thing. With no actions the whole card is its one control, announced as a link named by its title; with `actions` as well, its buttons are secondary controls beside that press: the body still opens it, the title is the link the keyboard reaches (Enter or Space), and no control sits inside another.
- Parts are set apart by space, never by a rule between them.
- Cards in a row share a height; the name stops after two lines, the byline truncates and the description stops after two lines.
- A `row` is one line: everything in it truncates or drops out of sight rather than wrapping; on a phone its facts give way to the title and its chips shrink. Its title gives way before its when is cut, and its note shows only where the line has room for it (a 22rem line), never as a sliver of one letter. A row draws a lead only when it has an icon, a picture or a tone. A row's `controls` with no buttons beside them (a Take out) stay on its one line at any width.
- A listing with only an id and a title still draws a whole card and a whole row.
- Someone at the work now (`face.working`) shows on their face: a short blue stroke runs around its soft-square edge (still under reduced motion).
- A `whole` row never cuts its title: it wraps, with when and the note on one quiet line under it; the row is still one press when opened.
- Work still going on (`progress`) shows on the lead tile: a ring in the tile's tone that fills, announced as a progress bar, or the shared loading mark while how far is not known.
- An off-screen card costs no layout (`content-visibility: auto` with an intrinsic size), so thousands scroll smoothly.

## Appearance

Layout is Tailwind utilities over the coss tokens the workspace already uses (`bg-card`, `border`, `text-muted-foreground`). The tone colours of the corner badge, the signal dot, the mark and the tinted lead tile are `parts/screen-look/show/listing-card.css` (imported by the card, so it ships in the bundle's stylesheet), the same colours `guide.css` gives the guide's status badges; the coss theme has no tone colours of its own.

## References (anatomy only)

- Dropbox Dash stacks (cover band, icon over its edge, count and time, avatars at the foot): https://mobbin.com/screens/dfc4e588-5798-48db-b912-d774b71877bb
- Mailchimp share-a-post (each place's card is the post itself with that place's logo): https://mobbin.com/screens/e092458d-2836-4628-b460-9a724277b8f0
- Kit choose your template (a preview sheet on top, the name under it): https://mobbin.com/screens/5a10bd07-3ec4-453c-b116-ca44f915d63e
- MagicPath shared with me (a pending invite card with Accept and Decline): https://mobbin.com/screens/2c8974ad-4585-48f0-922d-2a7b21851b9c

- Supabase Integrations: https://mobbin.com/screens/0145cf1c-cb24-4847-950b-0cad19752087
- Perplexity Connectors: https://mobbin.com/screens/de0d9c72-9791-49c0-9a99-c1081c3a51f3
- Calendly Integrations & apps: https://mobbin.com/screens/126d45b7-8e22-4a4f-9c38-c39f12967a94
- 21st.dev Recipe Card (component 22103): https://21st.dev/@ziegfiroyt/components/automation10

## Dependencies

**Depends on:** `../icon` (NamedIcon), `../coss/ui/button` (Button), `../avatar-group` (AvatarGroup), `../person-tag` (PersonTag), `../record-chip` (RecordChip), `../fact-chips` (FactChips), `../loading-mark` (LoadingMark), `../provider-mark` (ProviderMark, resolveProviderMark, the shipped provider-icon rows), `../cn`.

**Depended on by:** `src/workspace/tray-screen.tsx` (Your tray: each picked thing as a row with Take out), `src/workspace/workshop-screen.tsx` (the Workshop's tools), `src/workspace/marketplace-screen.tsx` (the Marketplace), `src/workspace/spaces-screen.tsx` (invitations and spaces on Spaces), `../dashboard` (Home's list rows, row form), `../examples-strip`, `../notifications` (every notification, toast and center row, is the row form). Tested by `test/listing-card-glance.test.mjs`.
