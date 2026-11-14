# Apeak Mental Surfaces — Reference-Grounded Screen Contract (Fable-5 redesign)

**Date:** 2026-07-03
**Author:** Claude Fable 5 (Mobbin MCP grounding, live)
**Bar:** Calm / Headspace / Oura / Whoop tier. Ambience beats chrome; readout-first; one clear thing per surface; zero jargon.
**Rules honored:** compose only `packages/ui` + screen-look tokens (L065/L066); fields/tones = DATA (Generic Gate, L090); value on first render with zero input (L083); human coach voice (L114/L115/L118).

## Cross-cutting anatomy (derived from ALL references)

The prior renders failed for four structural reasons, each fixed by a generic primitive:

1. **No ambience.** Every reference (Oura readiness, Calm pacer, TIDE home, Liven plan) sits on a full-bleed tonal gradient — never flat black. → New `ui` **AmbientSurface** primitive: a token-driven full-bleed gradient wash (named palettes: `night`, `dusk`, `dawn`, `ember`, `forest`, `mist`), selected per-view by DATA with an honest plain fallback.
2. **Full-width stretched cards on desktop.** References are a centered reading column. → Surface gains a generic centered content column (`hero` width for focal surfaces).
3. **Flat identical gray cards.** References tint the hero card with the tone of its content (Oura's photo header, Fabulous' tonal routine pills, Calm's blue). → Card washes keyed off the existing DATA `tone` vocabulary; bigger glowing IconTiles.
4. **Timid typography.** References lead with display-size statements. → Hero titles move up to `heading-xl`/`display`, eyebrows become letter-spaced overlines, body stays quiet.

---

## Surface 1 — CHECK-IN (readout-first mood card)
*(Grounded 2026-07-02 pass — stoic., Alan Mind, Liven, Fitbit, Calm; see research file. Anatomy retained verbatim.)*

- Populated: ONE readout card — result sentence in coach voice as the title, tonal accent tints icon + eyebrow.
- Empty: one warm hero on an ambient surface, big icon+word pills (choices layout), single human prompt.
- Never: eyebrow + title + AI-paragraph + tiny selectors.
- Primitives: guidance-cue leaf + `tone` handle + choices tiles; NEW: ambient surface, larger tap tiles with tonal glow icons.
- States: empty / matched(steady|tense|flat tones) / mobile / desktop.

## Surface 2 — BREATHING (box-breathing / reset-breath)
*(Grounded 2026-07-02 pass — Calm, Calm Sleep, Breathwrk, Forest, Alan Mind.)*

- Full-bleed ambient gradient IS the surface (cool night-blue). One large soft focal circle mid-phase; thin track ring; phase word centered; count chips (in 4 · hold 4 · out 4 · hold 4) quiet at top; steadying coach line below.
- Primitives: `breathing-pacer` role + BreathingPacer (elevate: phase-tinted glow, track ring, pattern chips) + AmbientSurface.
- States: mid-phase frame, pre-start, mobile, desktop.

## Surface 3 — MENTAL READOUT (regulation metrics)

### Real Mobbin screens opened
| App | Screen | What it teaches | Mobbin |
|---|---|---|---|
| **Oura** | Home readiness card "90 · Optimal · Rise and shine" | THE readout anatomy: eyebrow category → big score with crown → verdict word directly under → coach-voice headline → 2-3 lines of warm prose. All on an ambient photo/gradient card. | https://mobbin.com/screens/146a11e1-f12f-4536-810a-029788d8a1ce |
| **Oura** | Readiness detail + contributors | Score card, then "contributors" rows each with label + tonal mini-bar + verdict word ("Optimal" / "Pay attention"). Supporting stats NEVER compete with the hero. | https://mobbin.com/screens/caa464a2-970e-4747-a1a0-7094287560ec |
| **WHOOP** | Overview ring 58% + HRV/Sleep flanks | Dark theme done right: ONE colored ring hero, small flanking stats, everything else recedes. | https://mobbin.com/screens/6a012278-d01c-473e-b860-3c08e35311ed |

### Derived anatomy
- Centered hero column on an ambient wash keyed to the tone (positive → calm teal-green; caution → warm amber dusk; critical → soft ember red — DATA-driven, same `tone` vocab).
- Ring: score centered, **verdict band word directly under the number** (Oura's "Optimal"), then coach headline caption. Supporting stat strip beneath, quiet.
- States: positive / caution / critical (DATA only), mobile, desktop.

## Surface 4 — YOUR JOURNEY (progress arc / path-rail)

### Real Mobbin screens opened
| App | Screen | What it teaches | Mobbin |
|---|---|---|---|
| **Headspace** | "Basics" course — numbered session coins + NEXT SESSION pill | A course is coins on a soft field: done=filled+check, current=dark, upcoming=outline. One obvious CTA. | https://mobbin.com/screens/f949a759-8224-48f6-aafe-e1d0084c0cdd |
| **Noom** | Course progress serpentine 101→204 | Winding rail with icon coins, chapter numbers, color shifts by chapter; generous whitespace. | https://mobbin.com/screens/d2250a7a-316b-4b17-8c99-804585865627 |
| **Liven** | "Personalized plan" chapter path on warm gradient | Ambient cream/peach gradient behind glowing gold coins; current node ringed + bubble; locked = pale outline. Chapter header card on top. | https://mobbin.com/screens/d98bf80c-9d46-45c6-833d-d0baef1b2e1d |

### Derived anatomy
- Ambient soft gradient behind the rail; coins get glow + ring for current (bubble "START HERE"), dimmed outline for upcoming, filled check for done — all existing statusOverrides DATA.
- Captions beside coins in real type (not micro-labels).
- States: pre-launch (node1 current), mid-progress, mobile, desktop.

## Surface 5 — PRE-MATCH ROUTINE (timeline)

### Real Mobbin screens opened
| App | Screen | What it teaches | Mobbin |
|---|---|---|---|
| **Fabulous** | "Your Routines" — Morning/Afternoon/Evening tonal pills on a dotted rail | Each step is a TONAL card (sky/gold/night gradients) with its time above — the routine feels like a day arc, alive not administrative. | https://mobbin.com/screens/ff327143-7e4b-441d-b9bc-910b19cc378a |
| **Tiimo** | Today timeline — soft pills, time chips, tiny icon dots | Time labels small-caps and quiet; the card carries the identity. | https://mobbin.com/screens/2e5e28b9-c537-46b3-89fe-5d46c59fe6a3 |

### Derived anatomy
- Keep the connected rail + glowing icon badges; time labels as letter-spaced overlines; step cards soft-filled; the WALK ON final step visually distinct (accent) as the arrival moment.
- States: full routine, mobile, desktop.

## Surface 6 — REFLECT (journaling)

### Real Mobbin screens opened
| App | Screen | What it teaches | Mobbin |
|---|---|---|---|
| **5 Minute Journal** | Daily entry — quote header + eyebrow-labeled prompt cards | Prompts are SOFT CARDS each led by a small warm overline ("3 THINGS I AM GRATEFUL FOR…") + ghost placeholder answer. Calm, roomy, zero chrome. | https://mobbin.com/screens/ecc4961e-6952-4c89-96b0-cf4e5f80eaeb |
| **stoic.** | Journaling interstitial | A reflection screen can be almost pure typography — one warm serif-feel statement, huge whitespace. | https://mobbin.com/screens/732b5b6e-715a-4a58-8159-165595aaaf0e |
| **Alan Mind** | Guided question + voice chip | One question per beat, big; helper prose one quiet line. | https://mobbin.com/screens/3604062f-6162-46ff-b80b-67d8d77777db |

### Derived anatomy
- Tonight hero (guidance-cue, dusk ambient) → the 3 questions as numbered soft prompt cards (recommendation-list, quiet rank chips) → moment cards.
- States: fresh evening / streak chip present, mobile, desktop.

## Surface 7 — ATHLETE BRAIN (library)

### Real Mobbin screens opened
| App | Screen | What it teaches | Mobbin |
|---|---|---|---|
| **TIDE** | "Good day" home — greeting display type, horizontal content cards, Library tiles | Big warm greeting; content in generous cards with soft imagery; categories as tiles, not tables. | https://mobbin.com/screens/aa5ee839-9bca-4096-882c-07e6feb24cd2 |
| **Calm Sleep** | "EXERCISE · Move to center yourself" card + Play pill | The canonical content card: overline category → display title → media/ambient block → meta line + one Play pill. | https://mobbin.com/screens/e78f5db8-e483-43c0-bf7e-45fb483e2d8f |
| **Open** | Home — editorial dark, DAILY QUOTE, FEATURED SERIES | Dark library = editorial typography + section overlines; restraint reads premium. | https://mobbin.com/screens/ad03552e-0062-4af5-87d0-787c9e920f27 |

### Derived anatomy
- Featured "Start here" hero card (large, ambient, tonal) then category sections with overline headers and a responsive grid of quieter cards (title + one-line body + small tinted icon).
- States: featured+4 sections dense, mobile, desktop.

## Surface 8 — BEFORE YOU PLAY (90-sec reset) & Surface 9 — TOOLKIT (in-the-moment resets)

Grounded on Calm Sleep hero-card anatomy + Headspace SOS-card pattern (category color per situation — see toolkit tones) + Fabulous tonal pills:
- Before-you-play: ONE hero card, dusk ambient, big glowing icon, overline situation, display title, 2-3 line protocol, one full-width "I did my reset" pill.
- Toolkit: 4 situation cards, each tinted by its DATA tone (go-green / ease-amber / alert-ember / neutral), 2-up grid on desktop, stacked mobile.
- States: single hero / 4-card toolkit, mobile, desktop.

## Surface 10 — MENTAL GAME PATH (roadmap, recommendation-list)

Grounded on Headspace Basics (numbered sessions, one recommended CTA) + Noom chapters: numbered steps as soft cards, rank as a quiet coin (not a boxy badge), "Start here" as the single tonal accent, reasons as warm prose.

---

## Primitive work (all generic, token-driven, zero domain vocab)
| Primitive | Home | What |
|---|---|---|
| `AmbientSurface` | `packages/ui/show/ambient-surface/` | Full-bleed layered radial/linear gradient wash; named palettes; content slot. Inline-style gradients (bracket-class-safe). |
| Card `wash` treatment | guidance-cue leaf via existing Card + IconTile tone handles | Tone-keyed soft gradient veil on hero cards. |
| BreathingPacer elevation | existing `packages/ui/show/breathing-pacer/` | Phase-tinted glow, progress track, pattern chips row. |
| ScoreRing verdict order | existing `packages/ui/show/score-ring/` | Number → band word under → caption (Oura order); larger. |
| Surface ambient + column | `ApeakSurface` | Reads DATA `view.look` { ambient, width } → AmbientSurface + centered column. Absent → today's exact render. |

## Render-state matrix (every surface)
empty · populated · tonal variants (where DATA declares tone) · mobile 414 · desktop 1280 — proven by the package-owned render harness. Historical dashboard proof screens are retired with the deleted package.
