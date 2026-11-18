// tools/check-a-computer-from-outside: a port that answers and is not declared is one finding; a declared port that does
// not answer is one finding; the row runs the program it names with the files it packs.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import { checkFromOutside, domainOf } from '../do-work/check-from-outside.mjs';

const listen = () => new Promise(resolve => { const server = net.createServer(socket => socket.end()); server.listen(0, '127.0.0.1', () => resolve(server)); });

test('an undeclared open port and a declared closed port are each one finding', async () => {
  const server = await listen();
  const closed = await listen(); const closedPort = closed.address().port; await new Promise(done => closed.close(done));
  const openPort = server.address().port;
  try {
    const seen = await checkFromOutside({ name: 'made-up', address: '127.0.0.1', declared_ports: [`${closedPort}/tcp`], also_try: [openPort] }, { proxy: '' });
    assert.deepEqual(seen.ports.find(port => port.port === openPort).open, true);
    assert.deepEqual(seen.findings.filter(finding => finding.about === String(openPort)).map(finding => finding.kind), ['undeclared-open-port']);
    assert.deepEqual(seen.findings.filter(finding => finding.about === String(closedPort)).map(finding => finding.kind), ['declared-port-closed']);
    const declared = await checkFromOutside({ address: '127.0.0.1', declared_ports: [openPort] }, { proxy: '' });
    assert.equal(declared.findings.some(finding => finding.about === String(openPort)), false, 'a declared open port is no finding');
  } finally { server.close(); }
});

test('a name\'s registered domain is its last two labels, three under a country\'s second level', () => {
  assert.equal(domainOf('app.example.com'), 'example.com');
  assert.equal(domainOf('www.example.co.uk'), 'example.co.uk');
  assert.equal(domainOf('example.ai.'), 'example.ai');
});

test('the row runs the program it packs, reaches the network only through the run\'s proxy and holds no value', () => {
  const row = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8')).records[0].payload;
  assert.equal(row.invoke.internet, true);
  assert.equal(row.invoke.credential_mounts, undefined);
  const packed = row.invoke.files.package_files[0];
  assert.ok(row.invoke.argv[1].startsWith(`${packed.at}/`));
  for (const path of packed.paths) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
});
