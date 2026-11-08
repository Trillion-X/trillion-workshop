export const beforePause = (stretches, at) => (at == null ? stretches : stretches.filter(stretch => stretch.start_ms < at));

/**
 * What listening sends off this Mac and what stays on it, worded from the same settings that decide it
 * (listen.leaves, DATA): each row shows only while all its `when` tests hold ({ setting: 'a.b', equals | not }),
 * so the list cannot say a sound is kept when keep_sound is off. Returns { leaves: [{ id, what, to }], stays: [{ id, what, to }] }.
 */
export function leavesOf(listen) {
  const at = path_ => path_.split('.').reduce((value, key) => value?.[key], listen);
  const shown = (listen.leaves ?? []).filter(row => (row.when ?? []).every(test => (Object.hasOwn(test, 'equals') ? at(test.setting) === test.equals : at(test.setting) !== test.not)));
  const words = row => ({ id: row.id, what: row.what, to: row.to });
  return { leaves: shown.filter(row => row.leaves).map(words), stays: shown.filter(row => !row.leaves).map(words) };
}

