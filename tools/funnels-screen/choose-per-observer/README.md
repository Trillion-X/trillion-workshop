# parts/choose-per-observer/

Picks one candidate per visitor (price experiments). The Worker imports `score-candidates.ts`. The traffic grouping files that sat here moved with the traffic tools to trillion-workshop `tools/traffic-attribution`.

## Files

| File | Purpose |
|------|---------|
| `read-data/score-candidates.ts` | Ranks candidates for one visitor from facts and a decider program (the Worker's price experiments). |
| `read-data/candidate-set-schema.ts` | Candidate set shapes for the scorer. |
| `part.json` | Public files: the scorer. |

## Dependencies

**Depends on:** nothing outside this part.

**Depended on by:** `src/` (score-candidates).
