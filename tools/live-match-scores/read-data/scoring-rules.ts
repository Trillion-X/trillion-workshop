// packages/live-match-score/read-data/scoring-rules.ts
//
// =============================================================================
// PURPOSE — dissolve the `LiveMatchSport` enum into open scoring-rule DATA (SCR01)
// =============================================================================
//
// `sport: 'tennis' | 'pickleball'` was a closed union that drove two things:
//   (1) the default scoring model (`defaultScoringModel(sport)` with an
//       `if (sport === 'pickleball')` branch), and
//   (2) the score DISPLAY (`match.sport === 'tennis' ? tennisPointLabels(...) :
//       raw`) plus the tiebreak phase (`match.sport === 'tennis' && ...`).
//
// Neither needs a sport. A match references a `scoring-rule` RECORD (open set);
// the rule carries its own scoring model + display DATA. Tennis, pickleball,
// padel, table-tennis, badminton, a house rule — each is a `scoring-rule` row,
// ZERO code per sport (enum dissolution / L090). The reduce-graph op (DMG01) is
// the running-state engine; these helpers are the pure phase + display readers
// that the score surface uses instead of branching on a sport literal.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import type { LiveMatchScoringModel, LiveScoreSide, LiveScorePayload } from "./live-match-score-types.ts";

/** A scoring-rule record (DATA). Replaces the `sport` enum: a match points at one
 *  of these by `ruleId`; the open set of rules is the open set of "sports". The
 *  `scoringModel` carries the win structure AND the display DATA (`pointLabels`,
 *  `advantageLabel`) — so display is configured, never branched. */
export type ScoringRuleRecord = {
  kind: "scoring-rule";
  ruleId: string;
  label: string;
  scoringModel: LiveMatchScoringModel;
};

const SIDES: LiveScoreSide[] = ["team-a", "team-b"];

function pair(value: Record<LiveScoreSide, number> | undefined): Record<LiveScoreSide, number> {
  return {
    "team-a": Number(value?.["team-a"] ?? 0),
    "team-b": Number(value?.["team-b"] ?? 0),
  };
}

/**
 * The scoring phase, read from the rule's model — NOT from a sport literal.
 * Tiebreak applies when the rule declares a tiebreak (`tiebreakAt > 0`) and both
 * sides have reached it. A rule with `tiebreakAt === 0` (e.g. pickleball) never
 * enters tiebreak, with zero sport check. An explicit phase wins if provided.
 */
export function resolveScoringPhase(
  model: LiveMatchScoringModel,
  gameScores: Record<LiveScoreSide, number>,
  explicitPhase?: string
): string {
  if (explicitPhase) return explicitPhase;
  const games = pair(gameScores);
  if (
    model.tiebreakAt > 0 &&
    games["team-a"] >= model.tiebreakAt &&
    games["team-b"] >= model.tiebreakAt
  ) {
    return "tiebreak";
  }
  return "standard";
}

/**
 * Display scores, read from the rule's model DATA — NOT from a sport literal.
 * When the model declares `pointLabels` (e.g. ["0","15","30","40"]) the labeled
 * ladder is used, including a deuce/advantage zone when `advantageLabel` is set
 * (the generic form of the old tennis 40-40 / AD logic). When the model has no
 * `pointLabels`, raw point counts are shown (e.g. pickleball). Tiebreak/complete
 * phases always show raw counts. This reproduces `tennisPointLabels` exactly for
 * a tennis rule and the raw path exactly for a pickleball rule.
 */
export function resolveDisplayScores(
  model: LiveMatchScoringModel,
  pointScores: Record<LiveScoreSide, number>,
  teamScores: Record<LiveScoreSide, number>,
  phase: string
): Record<LiveScoreSide, string> {
  const points = pair(pointScores);
  const teams = pair(teamScores);
  const labels = model.pointLabels;

  // No labeled ladder, or a phase that scores by raw count -> raw strings.
  if (!Array.isArray(labels) || labels.length === 0 || phase === "tiebreak" || phase === "complete") {
    // pickleball-style display reads the team (point) score directly.
    const source = !Array.isArray(labels) || labels.length === 0 ? teams : points;
    return { "team-a": String(source["team-a"]), "team-b": String(source["team-b"]) };
  }

  const last = labels.length - 1; // index of the final ladder label (e.g. "40")
  const a = points["team-a"];
  const b = points["team-b"];

  // Deuce / advantage zone: both at or past the final label.
  if (model.advantageLabel && a >= last && b >= last) {
    if (a === b) return { "team-a": labels[last], "team-b": labels[last] };
    return {
      "team-a": a > b ? model.advantageLabel : labels[last],
      "team-b": b > a ? model.advantageLabel : labels[last],
    };
  }

  return {
    "team-a": labels[Math.min(a, last)] ?? String(a),
    "team-b": labels[Math.min(b, last)] ?? String(b),
  };
}

/** Apply the rule's phase + display to a raw score payload — the sport-free
 *  replacement for `normalizeSportScore`'s `match.sport === 'tennis'` branches. */
export function applyScoringRuleDisplay(model: LiveMatchScoringModel, score: LiveScorePayload): LiveScorePayload {
  const teamScores = pair(score.teamScores);
  const gameScores = pair(score.gameScores ?? teamScores);
  const pointScores = pair(score.pointScores);
  const setScores = pair(score.setScores);
  const scoringPhase = resolveScoringPhase(model, gameScores, score.scoringPhase);
  return {
    ...score,
    setNumber: score.setNumber || 1,
    teamScores,
    pointScores,
    gameScores,
    setScores,
    displayScores: resolveDisplayScores(model, pointScores, teamScores, scoringPhase),
    scoringPhase,
  };
}

/** Find a scoring-rule record by id within a set of records (the picker source). */
export function findScoringRule(rules: ScoringRuleRecord[], ruleId: string | undefined): ScoringRuleRecord | null {
  if (!ruleId) return rules.length ? rules[0] : null;
  return rules.find((r) => r.ruleId === ruleId) ?? (rules.length ? rules[0] : null);
}

// --- Reference scoring-rule DATA (seed). These are DATA rows, not code paths.
// A new "sport" is one more row here (or authored to the live log), zero code. --

/** Standard tennis: best-of sets, 6 games/set, tiebreak at 6-6, 0/15/30/40/AD. */
export const TENNIS_SCORING_RULE: ScoringRuleRecord = {
  kind: "scoring-rule",
  ruleId: "scoring-rule:tennis-standard",
  label: "Tennis",
  scoringModel: {
    scoreUnit: "game",
    setsToWin: 2,
    gamesToWinSet: 6,
    tiebreakAt: 6,
    pointsToWinTiebreak: 7,
    winBy: 2,
    pointLabels: ["0", "15", "30", "40"],
    advantageLabel: "AD",
  },
};

/** Pickleball: single game to 11, win by 2, raw point display, no tiebreak. */
export const PICKLEBALL_SCORING_RULE: ScoringRuleRecord = {
  kind: "scoring-rule",
  ruleId: "scoring-rule:pickleball-11",
  label: "Pickleball",
  scoringModel: {
    scoreUnit: "point",
    setsToWin: 1,
    gamesToWinSet: 11,
    tiebreakAt: 0,
    pointsToWinTiebreak: 0,
    winBy: 2,
  },
};

/** Padel: tennis-like display but golden point (no advantage) — proves the
 *  deletion test: a NEW rule scores/displays with zero code change. */
export const PADEL_GOLDEN_POINT_RULE: ScoringRuleRecord = {
  kind: "scoring-rule",
  ruleId: "scoring-rule:padel-golden-point",
  label: "Padel (golden point)",
  scoringModel: {
    scoreUnit: "game",
    setsToWin: 2,
    gamesToWinSet: 6,
    tiebreakAt: 6,
    pointsToWinTiebreak: 7,
    winBy: 1,
    pointLabels: ["0", "15", "30", "40"],
    // no advantageLabel -> 40-40 is sudden death, displayed 40/40, no AD
  },
};

export const REFERENCE_SCORING_RULES: ScoringRuleRecord[] = [
  TENNIS_SCORING_RULE,
  PICKLEBALL_SCORING_RULE,
  PADEL_GOLDEN_POINT_RULE,
];
