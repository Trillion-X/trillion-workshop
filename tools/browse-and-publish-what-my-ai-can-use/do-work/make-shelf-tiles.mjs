// Real Marketplace items + their real lucide icons (item icon, else the kind's icon) -> a tiles file a page draws
//
// tools/browse-and-publish-what-my-ai-can-use/do-work/make-shelf-tiles.mjs, moved from a film repository's
// tools/build-tiles.mjs (5a9ba39; byte-copied in its first commit here, then adapted). Run on the person's computer:
//
//   node tools/browse-and-publish-what-my-ai-can-use/do-work/make-shelf-tiles.mjs --tools FILE --workflows FILE \
//     --icons <lucide-react>/dist/esm/icons --out FILE [--global TILES]
//
// --tools and --workflows are JSON files of { items: [{ id, kind, title, job, steps?, icon? }] } (default data/tools.json
// and data/workflows.json in the folder it runs in). --icons is the icons folder of an installed lucide-react (default:
// the one in the Trillion checkout this computer reports, TRILLION_CHECKOUT). --out gets `window.<global>=<tiles>;`
// (default tiles.js, global TILES). Each tile is { id, kind, title, job (90 characters), steps, icon, svg }.
// The last line printed is { result: { tiles, counts, written } } or { error }.
//
// Invariants
//   1. An icon is drawn from its own shape rows ([element, attributes], `key` left out), following an alias file (a
//      re-export of another icon) at most three hops; an icon with no file is drawn as its kind's icon
//      (marketplace-kinds.json).
//   2. A title that reads as a machine name (word-word_word, or any underscore) is not a tile.
//   3. The icon files are read as data, never run: the shape rows are parsed as JSON.
import fs from 'node:fs';
import kinds from '../marketplace-kinds.json' with { type: 'json' };

const argv = process.argv.slice(2);
const arg = name => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const fail = why => { console.log(JSON.stringify({ error: why })); process.exit(1); };
if (!arg('--icons') && !process.env.TRILLION_CHECKOUT) fail('give --icons: the dist/esm/icons folder of an installed lucide-react.');
const L = arg('--icons') ? `${arg('--icons')}/` : `${process.env.TRILLION_CHECKOUT}/node_modules/lucide-react/dist/esm/icons/`;      // in the Trillion checkout this computer reports
if (!fs.existsSync(L)) fail(`${L} is not a folder: give --icons, the dist/esm/icons folder of an installed lucide-react.`);
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
const itemsOf = file => { try { return JSON.parse(fs.readFileSync(file)).items; } catch (error) { return fail(`${file}: ${error.message}; give a JSON file of { items: [...] }.`); } };
const tools = itemsOf(arg('--tools') ?? 'data/tools.json');
const flows = itemsOf(arg('--workflows') ?? 'data/workflows.json');
if (!Array.isArray(tools) || !Array.isArray(flows)) fail('--tools and --workflows are JSON files of { items: [...] }.');
const kindIcon = Object.fromEntries(kinds.kinds.map(kind => [kind.id, kind.icon]));
// The shape rows as JSON: the file's unquoted attribute names quoted, nothing evaluated.
const nodeOf = text => JSON.parse(text.replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":').replace(/,(\s*[\]}])/g, '$1'));
const svgOf = async name => {
  let f = L + kebab(name) + '.mjs';
  for (let hop = 0; hop < 3 && fs.existsSync(f); hop++) {
    const txt = fs.readFileSync(f, 'utf8');
    const m = txt.match(/__iconNode = (\[[\s\S]*?\n\]);/);
    if (m) { const node = nodeOf(m[1]); return node.map(([t, a]) => `<${t} ${Object.entries(a).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join(''); }
    const r = txt.match(/from '\.\/([^']+\.mjs)'/); if (!r) return null; f = L + r[1];
  }
  return null;
};
const keep = [...tools, ...flows].filter(i => !/^[a-z0-9]+-[a-z_]+$/.test(i.title) && !i.title.includes('_'));
const out = [];
for (const i of keep) {
  const icon = i.icon || kindIcon[i.kind];
  const svg = (await svgOf(icon)) || (await svgOf(kindIcon[i.kind]));
  out.push({ id: i.id, kind: i.kind, title: i.title, job: (i.job || '').slice(0, 90), steps: i.steps || null, icon, svg });
}
const written = arg('--out') ?? 'tiles.js';
fs.writeFileSync(written, `window.${arg('--global') ?? 'TILES'}=` + JSON.stringify(out) + ';');
console.log(out.length, 'items;', out.filter(o => o.kind === 'tool').length, 'tools', out.filter(o => o.kind === 'workflow').length, 'workflows; own icons', out.filter(o => !['Wrench','Workflow'].includes(o.icon)).length);
const counts = { items: out.length, tools: out.filter(o => o.kind === 'tool').length, workflows: out.filter(o => o.kind === 'workflow').length,
  own_icons: out.filter(o => ![kindIcon.tool, kindIcon.workflow].includes(o.icon)).length };
console.log(JSON.stringify({ result: { tiles: out, counts, written } }));
