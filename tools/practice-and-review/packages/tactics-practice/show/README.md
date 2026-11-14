# Tactics Tactics Practice Show

This folder contains the tactics product surface mount and screen components.

## Components

- `TacticsPracticeSurface.tsx` — the assembled screen. Reads live records
  via the runtime-kit data hook, renders the daily tactic (prompt + answer cards
  + reason + submit, with an answer-locked feedback band), and composes the
  contest/season panels below. Submits through
  `action:practice-decision-loop.submit-response`.
- `PeerVoteSplit.tsx` — peer vote / result distribution as % bars per option
  with vote counts and the viewer's own pick marked.
- `TacticalRatingStandings.tsx` — ranked rating standings (rank · player ·
  points) with rank-movement marks, the viewer's row highlighted, and an
  optional promotion line.
- `OneOnOneContestPanel.tsx` — one-on-one head-to-head ("VS" + per-player
  comparison bars + leader marker) plus the peer-vote split for the contest.
- `SeasonTournamentPanel.tsx` — season tournament: invite-only badge + pending
  invites, divisions, round-grouped bracket with an "Advances" winner marker,
  champion banner, this-week scenario, and a coach-review panel.
- `humanize-ref.ts` — display helper that formats player reference strings into
  human labels without leaking a raw id and without fabricating an identity.
- `mount-tactics-practice.tsx` — surface mount.

All components reuse shared `ui` primitives (`Bar`, `Badge`, `Card`, `Container`,
`Divider`, `Text`, `Button`, `Textarea`) — none are forked, and no new shared
primitive was required. Package-specific screen flow and action semantics stay
local to this package.

## Mount Contract

Runtime Kit invokes package material entries with `{ el, props }`. The mount
keeps that shape and delegates React root lifecycle to the shared UI mount
primitive.

## Copy discipline

Visible empty states use plain contest names: one-on-one tactics contest and
season tactics tournament. Do not reintroduce old metaphor labels into
customer-facing copy. The banned backend vocabulary is asserted absent by
`__tests__/contest-season-surfaces.test.tsx` and `__tests__/surface-mount.test.tsx`.

The daily tactic empty state is an authoring starter, not static text. It must
show tactic title, two choices, point situation, and the `Open tactic` action.
One-on-one and season panels stay visible as compact waiting cards so the user
can see what unlocks next.

## Proof status

Mobbin-grounded references and component render proof are complete (see
`../proof/tactics-contests-mobbin-reference-proof.md`). Rendered in-app
desktop/mobile screenshots remain blocked (no headless transport + sign-in gate),
so visual completion stays open.
