# Tactics Tactics Practice Read Data

This folder owns tactics product records and view helpers over the generic
decision practice records.

The generic primitive remains in `practice-decision-loop`; this package owns
tactics translation and product configuration.

Current projections:

- `dailyTacticsContestView` assembles daily contest config, contest, scenario,
  prompt, votes, and rating effects.
- `oneOnOneTacticsContestView` assembles the same backend shape for two-player
  tactical contests.
- `seasonTournamentView` assembles season config, season, invite, division,
  bracket, weekly scenario, weekly generic prompt/evidence, result, champion,
  coachReview, and profile records.
