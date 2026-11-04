// do-work/list-every-connection.mjs
//
// Purpose: the one Connections list (tool:list-every-connection): every service a person can connect (this folder's
// records.json, one descriptor per service) and every place on their own computer Trillion can read
// (tools/bring-in-new-items-from-this-computer computer/computer-sources.json, one row per place), in one list of
// the same shape, from the two owners' rows as they are. Given what one look at the computer found
// (tool:look-for-the-places-on-this-computer's answer), each place says whether it is there.
//
//   node do-work/list-every-connection.mjs <services records.json> <place rows computer-sources.json> [<categories.json>]
//   request on stdin, answer as the last line
//
// Invariants:
// - Read only: it reads rows and the answer it is given, and connects, looks at or sends nothing.
// - No service or place is named here: each is a row of its owner, and a new one is one more row there.
// - A secret field's value never appears: of a service it says only how it connects (key, sign-in, carried).
// - One set of category words: connection-categories.json says which service category is which list category.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const CATEGORIES = new URL('./connection-categories.json', import.meta.url);

// How a person connects a service, from what its descriptor holds.
const howOf = payload => (payload.carriedBy ? 'carried-by-your-computer' : payload.acquire ? 'sign-in' : payload.credentialFields?.length ? 'key' : 'nothing-to-give');

/** The Connections list for `{ category?, looked? }` from the services' records and the place rows. */
export function listEveryConnection(request = {}, {services, places, categories = JSON.parse(readFileSync(CATEGORIES, 'utf8'))}) {
  const categoryOf = word => (word ? categories.same?.[word] ?? word : categories.none);
  if (request.category !== undefined && typeof request.category !== 'string') throw new Error('category is one category\'s name, such as Messages.');
  const looked = request.looked;
  if (looked !== undefined && !Array.isArray(looked?.sources)) throw new Error('looked is the answer of tool:look-for-the-places-on-this-computer: { sources: [...] }.');
  const stateOf = new Map((looked?.sources ?? []).map(source => [source.id, source]));
  const fromServices = services.things.map(thing => thing.payload).filter(payload => payload?.kind === 'service-connection-descriptor').map(payload => ({
    id: `service:${payload.vendor}`,
    kind: 'service',
    label: payload.name,
    category: categoryOf(payload.category),
    how: howOf(payload),
    ...(payload.instructions ? {about: payload.instructions} : {}),
    ...(payload.carriedBy?.steps ? {steps: payload.carriedBy.steps} : {}),
  }));
  const fromPlaces = places.sources.map(row => {
    const found = stateOf.get(row.id);
    return {
      id: `computer:${row.id}`,
      kind: 'computer-place',
      label: row.label,
      category: categoryOf(row.category),
      how: 'found-on-your-computer',
      ...(row.read?.route ? {arrives_as: row.read.route} : {}),
      ...(row.gate ? {gate: row.gate, gate_label: places.gates?.[row.gate]?.label} : {}),
      ...(row.carries ? {carries: `service:${row.carries}`} : {}),
      // Not looked at: unknown. Looked at and not in the answer: not on this computer.
      state: looked ? (found?.state ?? 'not_here') : 'not_looked',
      ...(found?.detail ? {detail: found.detail} : {}),
    };
  });
  const connections = [...fromServices, ...fromPlaces]
    .filter(item => request.category === undefined || item.category === request.category)
    .sort((left, right) => left.category.localeCompare(right.category) || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  const count = kind => connections.filter(item => item.kind === kind).length;
  return {said: `${count('service')} services and ${count('computer-place')} places on your computer${request.category ? ` in ${request.category}` : ''}.`, connections};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  try {
    const [servicesFile, placesFile] = process.argv.slice(2);
    if (!servicesFile || !placesFile) throw new Error('Give the services\' records.json and the place rows computer-sources.json.');
    const [, , categoriesFile] = process.argv.slice(2);
    const rows = {services: JSON.parse(readFileSync(servicesFile, 'utf8')), places: JSON.parse(readFileSync(placesFile, 'utf8')), ...(categoriesFile ? {categories: JSON.parse(readFileSync(categoriesFile, 'utf8'))} : {})};
    process.stdout.write(`${JSON.stringify(listEveryConnection(text.trim() ? JSON.parse(text) : {}, rows))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({error: String(error.message ?? error)})}\n`);
    process.exitCode = 1;
  }
}
