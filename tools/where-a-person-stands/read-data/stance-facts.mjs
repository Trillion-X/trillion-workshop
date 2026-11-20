// tools/where-a-person-stands/read-data/stance-facts.mjs
//
// The computed facts of where a person stands on one record: the stand kept on it, looked up in the stand rows
// (read-data/stances.json), checked against the record's decision generation. Pure: it reads nothing, keeps nothing,
// knows no clock and no words. The caller formats the day of `status.at` and writes every word.
//
//   stanceFacts({ record, stance, stances }) where record is the thing the stand is on (its decision_generation, when
//   it has one), stance is the stand kept on it ({ stance, at, why, decision_generation? }) or null, and stances is the
//   `stances` rows of read-data/stances.json. Returns:
//     said         the row's words, when the stand was taken on the record's current version
//     earlier_said the row's words, when it was taken on an earlier version (decision_generation differs)
//     why          the person's own words, or null
//     detailed     true when there are words of why, or an earlier version's stand to explain
//     status       { at, tone } from the stand's row, or null when there is no stand row
//     choices      every stand row as { id, label, icon, primary }; primary marks the current stand on the current version
//
// A stand with no decision_generation is never earlier. A record with none counts as generation 1.
const takenOn = (stance, record) => Boolean(stance?.decision_generation && stance.decision_generation !== (record.decision_generation ?? 1));

export function stanceFacts({ record, stance, stances }) {
  const row = stances.find(item => item.id === stance?.stance) ?? null;
  const earlier = takenOn(stance, record);
  const why = stance?.why || null;
  return {
    said: row && !earlier ? row.said : null,
    earlier_said: row && earlier ? row.said : null,
    why,
    detailed: Boolean(why || (row && earlier)),
    status: row ? { at: stance.at ?? null, tone: row.tone } : null,
    choices: stances.map(item => ({ id: item.id, label: item.label, icon: item.icon ?? null, primary: item.id === stance?.stance && !earlier })),
  };
}
