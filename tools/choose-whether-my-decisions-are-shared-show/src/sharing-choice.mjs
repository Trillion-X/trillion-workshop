// Whether a person's decisions are shared: what they chose, or else the default in src/pool-settings.json
// (sharing_defaults). A default covers only decisions made on or after its from_day, so a decision made before a
// default changed stays as private as it was promised to be. An explicit choice, on or off, always wins.
//
// chosen    the person's stored choice: true, false, or undefined when they never chose
// row       the default row: { on, from_day: 'YYYY-MM-DD' }
// madeAt    the decision's created_at (ISO); omitted when asking what the screen should show
export function sharingChoice(chosen, row, madeAt) {
  if (typeof chosen === 'boolean') return chosen;
  if (row?.on !== true) return false;
  if (madeAt === undefined) return true;
  return typeof madeAt === 'string' && madeAt.slice(0, 10) >= row.from_day;
}

// What a sharing section shows: whether it is on, whether that is the person's own choice or the default, and the
// day the default began (decisions before it are never shared under the default).
export function sharingView(chosen, row) {
  return { on: sharingChoice(chosen, row), chosen: typeof chosen === 'boolean', from_day: row?.from_day ?? null };
}

// A default's from_day in words ('September 28, 2026').
export function fromDayWords(fromDay) {
  return new Date(`${fromDay}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
