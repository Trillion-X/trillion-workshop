# Tactics Tactics Practice Show Tests

Render-state proof for the package-local contest/season show components. These
run under vitest (jsdom + React Testing Library) and exercise the components with
type-accurate fixture data — fixtures are test inputs, not fake product data.

- `contest-season-surfaces.test.tsx` — renders `PeerVoteSplit`,
  `TacticalRatingStandings`, `OneOnOneContestPanel`, and `SeasonTournamentPanel`
  across empty / sparse / dense states; asserts key human copy is present and the
  banned backend vocabulary is absent; covers `humanize-ref`.
- `surface-mount.test.tsx` — mounts the assembled `TacticsPracticeSurface`
  (data hook mocked) and asserts the empty state composes with the three human
  empty-states and no backend words.

Run:

```bash
cd dev/bitfield-packages
npx vitest run --config ./vitest.config.ts packages/tactics-practice
```

These prove component rendering, not in-app user completion. In-app rendered
screenshots remain blocked — see `../../proof/tactics-contests-mobbin-reference-proof.md` §6.
