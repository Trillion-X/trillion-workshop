// tools/start-a-computer/do-work/fill-fields.mjs
//
// The one way a template becomes text: each {field} is the row's own value (a list is joined with spaces), and a field the
// row does not give is refused, so a template never renders half-filled. Rendering what a computer runs and the init rows share it.

export const fill = (template, values, where) => template.replace(/\{([a-z_]+)\}/g, (_, key) => {
  if (values[key] === undefined) throw new Error(`${where} needs ${key}`);
  return Array.isArray(values[key]) ? values[key].join(' ') : String(values[key]);
});
