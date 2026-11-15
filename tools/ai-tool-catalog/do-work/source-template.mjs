// The source kind's installed DATA projects its values into one tool-row-source.
// Shared by setup and live reads; this is the original account-live-sources
// projection moved here, with no I/O or credential admission.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fromSource(template, values) {
  if (Array.isArray(template)) return template.map(item => fromSource(item, values));
  if (!object(template)) return template;
  if (Object.keys(template).length === 1 && object(template.fill) && template.fill.from === 'source') return values[template.fill.field] ?? template.fill.default;
  return Object.fromEntries(Object.entries(template).map(([key, item]) => [key, fromSource(item, values)]).filter(([, item]) => item !== undefined));
}
export function rowSourceOf(source, kinds) {
  const values = { ...source, name: source.name ?? new URL(source.url).host, tool_prefix: `tool:${source.id}:`, connection_record: source.connection?.connection };
  return fromSource(kinds[source.kind].source, values);
}
