// tools/keep-a-caddy-front-door-on-a-computer/test/paths-to-a-socket-at-names.test.mjs
//
// routes/paths-to-a-socket-at-names.caddy: the paths of some names that one program answers, sent to its one socket and sent
// no-store. Filled from a site's fields the way the kit fills every route, it names the row's hosts, paths and socket only, and
// the Caddy that the site names accepts it inside a site block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fill } from '../../start-a-computer/do-work/fill-fields.mjs';

const ROUTE = readFileSync(new URL('../routes/paths-to-a-socket-at-names.caddy', import.meta.url), 'utf8').trimEnd();
const journey = {
  socket_path_hosts: ['example.test', 'www.example.test'],
  socket_paths: ['/go/*', '/observe/visit', '/before-booking/*'],
  socket_path: '/run/example-program/journey.sock',
};
const filled = fill(ROUTE, journey, 'route');

test('the route sends the listed paths of the listed names to the one socket, and sends their answers no-store', () => {
  assert.match(filled, /^\t@socket_paths_at_names \{\n\t\thost example\.test www\.example\.test\n\t\tpath \/go\/\* \/observe\/visit \/before-booking\/\*\n\t\}$/m);
  assert.match(filled, /handle @socket_paths_at_names \{\n\t\theader Cache-Control "no-store"\n\t\treverse_proxy unix\/\/run\/example-program\/journey\.sock \{\n/);
  assert.doesNotMatch(filled, /\{[a-z_]+\}/, 'every field is filled');
});

test('a route with a field the site does not give is refused, never rendered half-filled', () => {
  const { socket_path: _omitted, ...rest } = journey;
  assert.throws(() => fill(ROUTE, rest, 'route'), /route needs socket_path/);
});

test('the Caddy the site names accepts the route inside a site block', { skip: spawnSync('caddy', ['version']).status !== 0 && 'caddy is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'paths-to-a-socket-'));
  const file = join(dir, 'Caddyfile');
  writeFileSync(file, `{\n\ton_demand_tls {\n\t\task http://localhost:5601/\n\t}\n}\n\nhttps:// {\n\ttls {\n\t\ton_demand\n\t}\n${filled}\n\thandle {\n\t\trespond "Not found" 404\n\t}\n}\n`);
  const checked = spawnSync('caddy', ['validate', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});
