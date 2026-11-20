// What a reading sees, turned into pursuit records: the pursuits to add (none of the recorded ones), the areas to add to
// a recorded pursuit, and the end of a pursuit a reading found earlier that no later reading sees. Pure: the caller
// records the result. The recording settings (found_by, where) are content the caller hands in.

const list = value => (Array.isArray(value) ? value : []);

// A pursuit's id as the recording store makes it from a title, so a title a reading sees names the same pursuit.
const pursuitId = title => 'pursuit:' + String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * What a reading turns into pursuits, given the pursuits it sees and the ones recorded:
 *   add     every pursuit it sees with evidence, where it is now and where it should get to, that is none of the recorded
 *           ones (by the id it named or its title), recorded as found_by the reading with its evidence and areas
 *   update  a recorded pursuit it sees with areas the pursuit does not have yet: those areas added, nothing else changed
 *   end     a pursuit a reading found earlier (found_by the reading, not ended) that this reading no longer sees
 * A pursuit the person or another AI recorded is never ended here. A grouped pursuit is a parent the consolidation made
 * from several others: no reading sees it, so it is never ended here either.
 *
 * recording: { found_by, where } (content; where is the evidence's place). mergedAway: ids a consolidation merged away,
 * kept for one reading so their leftover title is not found again.
 */
export function foundPursuits(seen, recorded, { recording, at = new Date().toISOString(), mergedAway = new Set() } = {}) {
  const { found_by, where } = recording;
  const live = list(recorded).filter(item => item?.status !== 'ended');
  const byId = new Map(live.map(item => [item.id, item]));
  const matched = new Set();
  const add = [];
  const update = [];
  for (const pursuit of list(seen)) {
    // A duplicate the consolidation merged away is still in the picture until the next reading: it is not found again.
    if (mergedAway.has(pursuit.recorded) || mergedAway.has(pursuitId(pursuit.title))) continue;
    const same = byId.get(pursuit.recorded) ?? byId.get(pursuitId(pursuit.title));
    if (same) {
      matched.add(same.id);
      const areas = [...new Set([...list(same.areas), ...list(pursuit.areas)])];
      if (areas.length > list(same.areas).length) update.push({ ...same, areas });
      continue;
    }
    if (!pursuit.evidence?.length || !pursuit.now || !pursuit.after) continue;
    add.push({
      title: pursuit.title, now: pursuit.now, after: pursuit.after, status: 'active', found_by, found_at: at,
      evidence: pursuit.evidence.map(quote => ({ where, date: at.slice(0, 10), quote_or_fact: quote })),
      ...(pursuit.areas?.length ? { areas: pursuit.areas } : {}),
    });
  }
  const end = live.filter(item => item.found_by === found_by && !item.grouped && !matched.has(item.id))
    .map(item => ({ ...item, status: 'ended', ended_at: at }));
  return { add, update, end };
}
