// Real Marketplace items + their real lucide icons (item icon, else the kind's icon) -> hf/assets/js/tiles.js
import fs from 'node:fs';
const L = `${process.env.TRILLION_CHECKOUT}/node_modules/lucide-react/dist/esm/icons/`;      // in the Trillion checkout this place reports
const kebab = s => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
const tools = JSON.parse(fs.readFileSync('data/tools.json')).items;
const flows = JSON.parse(fs.readFileSync('data/workflows.json')).items;
const kindIcon = { tool: 'Wrench', workflow: 'Workflow' };
const svgOf = async name => {
  let f = L + kebab(name) + '.mjs';
  for (let hop = 0; hop < 3 && fs.existsSync(f); hop++) {
    const txt = fs.readFileSync(f, 'utf8');
    const m = txt.match(/__iconNode = (\[[\s\S]*?\n\]);/);
    if (m) { const node = Function('return ' + m[1])(); return node.map(([t, a]) => `<${t} ${Object.entries(a).filter(([k]) => k !== 'key').map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join(''); }
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
fs.writeFileSync('hf/assets/js/tiles.js', 'window.TILES=' + JSON.stringify(out) + ';');
console.log(out.length, 'items;', out.filter(o => o.kind === 'tool').length, 'tools', out.filter(o => o.kind === 'workflow').length, 'workflows; own icons', out.filter(o => !['Wrench','Workflow'].includes(o.icon)).length);
