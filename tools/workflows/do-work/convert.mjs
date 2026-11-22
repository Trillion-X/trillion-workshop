// Writes every workflow of one Workshop export as the engine definition it runs as, plus _index.json for wf find.
// usage: node convert.mjs OUT_DIR [PREVIOUS_OUT_DIR]   (run from the Workshop tree that holds it: its own folder is the root)
// With PREVIOUS_OUT_DIR, a recipe whose bytes are unchanged since that folder's definitions-index.json (blake3 of the recipe as
// JSON) keeps its definition file as it was: definitionOf runs only for the recipes that changed or are new. The caller gives a
// previous folder only when no converter code changed (wf decides; see wf.rs definitions()).
// A workflow already kept in the engine's shape (tools/workflows/definitions/*.json) is taken as it is; every other recipe
// is converted with the Workshop's own definitionOf. This step goes away once every workflow on main is kept as a definition.
// The index holds, per workflow: id, label, job, kinds (every value its live fires_when conditions test on `kinds`) and
// words (its steps' own text), so wf can rank by kinds and words without reading 550 files.
import { copyFileSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
// A static relative import, so the Workshop's import walk (package-files.json) reaches the whole definitionOf closure.
import { definitionOf } from '../../write-a-job-done-in-several-steps-have/read-data/workflows.mjs';
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const [out, previous] = process.argv.slice(2);
if (!out) throw new Error('usage: node convert.mjs OUT_DIR [PREVIOUS_OUT_DIR]');
// The Workshop tree this file sits in: tools/workflows/do-work/convert.mjs, so its recipes and kept definitions are beside it.
const root = path.resolve(import.meta.dirname, '../../..');
const fileName = id => `${id.replace(/[^a-z0-9-]/gi, '_')}.json`;

const kindsIn = conditions => {
  const found = new Set();
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'rule' && node.field === 'kinds') for (const value of node.params?.values ?? []) found.add(value);
    for (const child of node.rules ?? []) walk(child);
  };
  for (const entry of Array.isArray(conditions) ? conditions : []) if (entry?.state !== 'Off') walk(entry?.condition?.tree);
  return [...found];
};
const stepWords = steps => (steps ?? []).map(step => [step.title, step.do, step.config?.input?.do].filter(t => typeof t === 'string').join(' ')).join(' ');

const index = [];
const failed = [];
const hashes = {};
const previousHashes = previous && existsSync(path.join(previous, 'definitions-index.json')) ? JSON.parse(readFileSync(path.join(previous, 'definitions-index.json'), 'utf8')) : {};
let converted = 0, reused = 0;
const recipes = path.join(root, 'tools/workflows/recipes');
for (const file of readdirSync(recipes).filter(name => name.endsWith('.json'))) {
  for (const record of JSON.parse(readFileSync(path.join(recipes, file), 'utf8')).records ?? []) {
    const recipe = record.payload ?? record;
    if (recipe.kind !== 'workflow-recipe' || !recipe.id) continue;
    const hash = makeHashCodeHexFromBytes(new TextEncoder().encode(JSON.stringify(recipe)));
    try {
      if (previousHashes[recipe.id] === hash && existsSync(path.join(previous, fileName(recipe.id)))) {
        copyFileSync(path.join(previous, fileName(recipe.id)), path.join(out, fileName(recipe.id)));
        reused += 1;
      } else {
        writeFileSync(path.join(out, fileName(recipe.id)), JSON.stringify(definitionOf(recipe)));
        converted += 1;
      }
      hashes[recipe.id] = hash;
      index.push({ id: recipe.id, label: recipe.label ?? '', job: recipe.job ?? '', kinds: kindsIn(recipe.fires_when), words: stepWords(recipe.steps) });
    } catch (error) { failed.push(`${recipe.id}: ${error.message}`); }
  }
}
writeFileSync(path.join(out, 'definitions-index.json'), JSON.stringify(hashes));
const kept = path.join(root, 'tools/workflows/definitions');
let asIs = 0;
if (existsSync(kept)) {
  for (const file of readdirSync(kept).filter(name => name.endsWith('.json'))) {
    // A kept file holds { _what, definitions: [the workflow, then any it uses] }; the run gets the first, with the rest as `uses`.
    const kept_file = JSON.parse(readFileSync(path.join(kept, file), 'utf8'));
    const [first, ...used] = Array.isArray(kept_file.definitions) ? kept_file.definitions : [kept_file];
    const definition = used.length ? { ...first, uses: [...(first.uses ?? []), ...used] } : first;
    const id = definition.id?.startsWith('workflow:') ? definition.id : `workflow:${definition.id ?? file.replace(/\.json$/, '')}`;
    writeFileSync(path.join(out, fileName(id)), JSON.stringify(definition));
    const at = index.findIndex(entry => entry.id === id);
    const had = at >= 0 ? index.splice(at, 1)[0] : null;
    index.push({ id, label: definition.name ?? had?.label ?? '', job: had?.job || kept_file._what || '', kinds: had?.kinds ?? [], words: stepWords(definition.steps) });
    asIs += 1;
  }
}
writeFileSync(path.join(out, '_index.json'), JSON.stringify(index));
console.log(JSON.stringify({ workflows: index.length, kept_as_definitions: asIs, converted, reused, failed: failed.length, first_failures: failed.slice(0, 5) }));
