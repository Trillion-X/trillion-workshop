// tools/what-would-it-do-for-a-pursuit/read-data/pursuit-plan-rules.mjs
//
// The limits and the closeness lines of the old pursuit plan, copied as DATA from src/pursuit-plan.json at b6ae0ebf815f (its
// `limits` and the numbers of its `moves` block; the moves themselves and their words are not copied here, they are the
// Marketplace's own). The closeness of a pursuit to a move or a row is measured by the caller's embedding, not here.
export const PURSUIT_PLAN_RULES = {
  limits: { workflows: 4, tools: 6, screens: 6, pursuit_min_chars: 3, pursuit_max_chars: 300 },
  moves: { count: 5, pick_min: 0.22, pick_ratio: 0.7, row_min: 0.36, row_ratio: 0.78, direct_min: 0.42 },
};
