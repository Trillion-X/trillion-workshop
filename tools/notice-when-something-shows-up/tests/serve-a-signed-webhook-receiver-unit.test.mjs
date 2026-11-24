// The receiver's unit template, rendered with neutral placeholder values: every placeholder is filled, the unit runs the
// receiver's program with its settings file, the carrier's hardening is kept, and no name, host, port or credential value
// is written into the template itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(path.join(here, '..', 'on-a-computer', 'serve-a-signed-webhook-receiver.service'), 'utf8');
const PLACEHOLDERS = {
  description: 'Example signed webhook receiver',
  credential_lines: 'LoadCredential=example-signing-secret:/var/lib/example/secret\nLoadCredential=example-account-key:/var/lib/example/key',
  state: '/var/lib/example-state',
  node_bin: '/usr/local/bin',
  workshop: '/var/lib/example-workshop',
  workshop_commit: '0000000000000000000000000000000000000000',
  repository: '/var/lib/example-repository.git',
  tool_folder: 'example-tool-folder',
  user: 'example-user',
  settings_file: '/var/lib/example-state/receiver.json',
  writable: '/var/lib/example-state /var/lib/example-workshop',
};
const render = (template, values) => template.replace(/\{([a-z_]+)\}/g, (match, name) => (Object.hasOwn(values, name) ? values[name] : match));

test('every placeholder in the template is one the carrier names, and rendering fills all of them', () => {
  const names = [...new Set([...TEMPLATE.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]))].sort();
  assert.deepEqual(names, Object.keys(PLACEHOLDERS).sort());
  const rendered = render(TEMPLATE, PLACEHOLDERS);
  assert.doesNotMatch(rendered, /\{[a-z_]+\}/);
});

test('the unit runs the receiver program with its settings file, from the Workshop copy at the pinned commit', () => {
  const rendered = render(TEMPLATE, PLACEHOLDERS);
  assert.match(rendered, /ExecStart=\/bin\/sh -c 'cd \/var\/lib\/example-workshop && exec node \/var\/lib\/example-workshop\/tools\/notice-when-something-shows-up\/do-work\/signed-webhook-receiver\.mjs \/var\/lib\/example-state\/receiver\.json'/);
  assert.match(rendered, /git -C \/var\/lib\/example-workshop fetch -q --depth 1 \/var\/lib\/example-repository\.git 0{40} /);
});

test('the carrier hardening is kept: no new privileges, a read-only system, a private home and the writable folders only', () => {
  const rendered = render(TEMPLATE, PLACEHOLDERS);
  for (const line of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'UMask=0077', 'Restart=always']) {
    assert.ok(rendered.includes(line), `missing ${line}`);
  }
  assert.match(rendered, /ReadWritePaths=\/var\/lib\/example-state \/var\/lib\/example-workshop/);
});

test('deployment values come only from placeholders, not concrete addresses or credentials', () => {
  const values = TEMPLATE.split('\n').filter((line) => /^(Description|User|Group|ReadWritePaths)=/.test(line));
  assert.deepEqual(values, ['Description={description}', 'User={user}', 'Group={user}', 'ReadWritePaths={writable}']);
  assert.match(TEMPLATE, /^\{credential_lines\}$/m);
  assert.doesNotMatch(TEMPLATE, /https?:\/\/|(?:\d{1,3}\.){3}\d{1,3}|^LoadCredential=/m);
});
