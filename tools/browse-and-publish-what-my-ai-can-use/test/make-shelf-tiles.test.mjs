// make-shelf-tiles.mjs against a made-up icons folder in lucide-react's file shape and made-up items: icons drawn from
// their shape rows, an alias followed, a missing icon drawn as its kind's, machine titles left out, the job cut, the
// page file written, and an icon file read as data, never run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('../do-work/make-shelf-tiles.mjs', import.meta.url));
const iconFile = (rows, name) => `/**\n * made-up icon\n */\n\nimport createIcon from '../createIcon.mjs';\n\nconst __iconNode = [\n${rows.map(row => `  ${row}`).join(',\n')}\n];\nconst Icon = createIcon("${name}", __iconNode);\n\nexport { __iconNode, Icon as default };\n`;

function world() {
  const root = mkdtempSync(join(tmpdir(), 'shelf-tiles-'));
  const icons = join(root, 'icons');
  mkdirSync(icons);
  writeFileSync(join(icons, 'wrench.mjs'), iconFile(['["path", { d: "M1 1h2", key: "a1" }]'], 'wrench'));
  writeFileSync(join(icons, 'workflow.mjs'), iconFile(['["rect", { width: "8", height: "8", x: "3", y: "3", rx: "2", key: "b1" }]'], 'workflow'));
  writeFileSync(join(icons, 'garden-hose.mjs'), iconFile(['["path", { d: "M4 4v8", key: "c1" }]', '["circle", { cx: "9", cy: "9", r: "2", key: "c2" }]'], 'garden-hose'));
  writeFileSync(join(icons, 'hose-square.mjs'), "export { default } from './garden-hose.mjs';\n");
  const tools = join(root, 'tools.json');
  const flows = join(root, 'workflows.json');
  writeFileSync(tools, JSON.stringify({ items: [
    { id: 'tool:hose', kind: 'tool', title: 'Water the beds', job: 'x'.repeat(120), icon: 'GardenHose' },
    { id: 'tool:alias', kind: 'tool', title: 'Water by alias', job: 'an alias', icon: 'HoseSquare' },
    { id: 'tool:none', kind: 'tool', title: 'No icon of its own', job: 'kind icon' },
    { id: 'tool:missing', kind: 'tool', title: 'An icon nobody has', job: 'kind icon drawn', icon: 'NoSuchShape' },
    { id: 'tool:machine', kind: 'tool', title: 'garden-hose_list', job: 'left out' },
    { id: 'tool:underscore', kind: 'tool', title: 'Plan_beds', job: 'left out' },
  ] }));
  writeFileSync(flows, JSON.stringify({ items: [{ id: 'workflow:season', kind: 'workflow', title: 'Plan a season', job: 'steps kept', steps: ['sow', 'water'] }] }));
  return { root, icons, tools, flows };
}

const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...process.env, TRILLION_CHECKOUT: '' } });
const answer = ran => JSON.parse(ran.stdout.trim().split('\n').at(-1));

test('tiles: own icons, an alias, the kind icon for a missing or absent icon, machine titles left out, the job cut', () => {
  const { root, icons, tools, flows } = world();
  const ran = run('--tools', tools, '--workflows', flows, '--icons', icons, '--out', join(root, 'tiles.js'));
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const { tiles, counts } = answer(ran).result;
  assert.deepEqual(tiles.map(t => t.id), ['tool:hose', 'tool:alias', 'tool:none', 'tool:missing', 'workflow:season']);
  assert.equal(tiles[0].svg, '<path d="M4 4v8"/><circle cx="9" cy="9" r="2"/>');
  assert.equal(tiles[0].job.length, 90);
  assert.equal(tiles[1].svg, tiles[0].svg, 'the alias file leads to the icon it re-exports');
  assert.deepEqual([tiles[2].icon, tiles[2].svg], ['Wrench', '<path d="M1 1h2"/>']);
  assert.deepEqual([tiles[3].icon, tiles[3].svg], ['NoSuchShape', '<path d="M1 1h2"/>']);
  assert.deepEqual([tiles[4].icon, tiles[4].steps, tiles[2].steps], ['Workflow', ['sow', 'water'], null]);
  assert.deepEqual(counts, { items: 5, tools: 4, workflows: 1, own_icons: 3 });
});

test('an icon file is read as data, never run: shape rows holding code are refused', () => {
  const { root, icons, flows } = world();
  writeFileSync(join(icons, 'trap.mjs'), iconFile(['["path", { d: (globalThis.ran = "x"), key: "t" }]'], 'trap'));
  const items = join(root, 'trap.json');
  writeFileSync(items, JSON.stringify({ items: [{ id: 'tool:trap', kind: 'tool', title: 'A trap', job: 'j', icon: 'Trap' }] }));
  const ran = run('--tools', items, '--workflows', flows, '--icons', icons, '--out', join(root, 'tiles.js'));
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /SyntaxError|JSON/);
});

test('the command writes window.<global>=tiles; and answers { result }, or { error } saying what to give', () => {
  const { root, icons, tools, flows } = world();
  const out = join(root, 'tiles.js');
  const ran = run('--tools', tools, '--workflows', flows, '--icons', icons, '--out', out, '--global', 'SHELF');
  assert.equal(ran.status, 0, ran.stderr);
  const last = answer(ran);
  assert.equal(last.result.counts.items, 5);
  const page = readFileSync(out, 'utf8');
  assert.match(page, /^window\.SHELF=\[/);
  assert.deepEqual(JSON.parse(page.slice('window.SHELF='.length, -1)), last.result.tiles);
  const bad = run('--tools', tools, '--workflows', flows, '--icons', join(root, 'nowhere'));
  assert.equal(bad.status, 1);
  assert.match(answer(bad).error, /dist\/esm\/icons folder of an installed lucide-react/);
  assert.equal(existsSync(join(root, 'nowhere')), false);
  assert.match(answer(run('--tools', tools)).error, /give --icons/);
  assert.match(answer(run('--tools', join(root, 'none.json'), '--workflows', flows, '--icons', icons)).error, /JSON file of \{ items/);
});
