// The reference for an id named with its kind. Keep this projection shared by
// record scope and browser inspections; the naming rules remain existing data.
import scopeData from './record-scope.json' with { type: 'json' };

export function refOf(kind, id) {
  const prefix = scopeData.refs[kind]?.prefix;
  return prefix ? `${prefix}${id}` : id;
}
