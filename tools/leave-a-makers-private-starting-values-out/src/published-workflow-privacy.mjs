// A controls interface can carry a person's initial values in screen.defaults in older saved workflow rows. Those
// values are private to the maker, so Marketplace copies omit the instance defaults while keeping the workflow's
// schema (which still supplies any tool-declared neutral defaults).
export function publishedWorkflowRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.screen?.kind !== 'controls' || !Object.hasOwn(row.screen, 'defaults')) return row;
  const { defaults: _privateDefaults, ...screen } = row.screen;
  return { ...row, screen };
}
