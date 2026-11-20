// Refuses a tool input that names a required field by an alias before the call is sent. An alias is a key the tool does
// not declare, sent where a declared required field is missing (for example `path` for `name_or_identity`). The old
// tool path refused such a call with the words below, so it never reached the tool, the store or the network. Without
// this check the call would wait for the person to supply the field, which is a different answer.
// Pure: it reads the input and the schema and returns words. It changes no value, so an exact Unicode identity passes.
// A tool whose schema sets additionalProperties to false is already refused by schemaProblems, so it is left alone here.

export function aliasProblems(input, schema) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !schema || typeof schema !== 'object') return [];
  if (schema.additionalProperties === false) return [];
  const declared = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter(name => Object.hasOwn(declared, name) && input[name] === undefined);
  const aliases = Object.keys(input).filter(key => !Object.hasOwn(declared, key));
  if (!missing.length || !aliases.length) return [];
  return [`Invalid input: missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`];
}
