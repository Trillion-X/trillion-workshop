// tools/check-a-computer-from-outside: a port that answers and is not declared is one finding; a declared port that does
// not answer is one finding; the row runs the program it names with the files it packs.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import { checkFromOutside, registrationOf } from '../do-work/check-from-outside.mjs';

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

test('a name stands under the nearest parent its registry says is registered, never a list of second levels', async () => {
  // A registry as rdap.org answered on Nov 18 2026: 404 or 400 for a name that is not registered, 200 for one that is.
  const registered = { 'bbc.co.uk': '2034-12-13', 'unimelb.edu.au': null, 'edu.au': null, 'example.ai': '2028-08-19' };
  const seen = [];
  const ask = async domain => {
    seen.push(domain);
    if (!(domain in registered)) throw Object.assign(new Error('the registry answered 404'), { status: 404 });
    return { domain, expires: registered[domain], days_left: null };
  };
  assert.equal((await registrationOf('www.bbc.co.uk', ask)).domain, 'bbc.co.uk');
  // The old list (co, com, org, net, ac, gov) took edu.au for this name.
  assert.equal((await registrationOf('www.unimelb.edu.au', ask)).domain, 'unimelb.edu.au');
  assert.equal((await registrationOf('example.ai.', ask)).domain, 'example.ai');
  const asked = new Map(); seen.length = 0;
  await registrationOf('a.example.ai', ask, asked); await registrationOf('b.example.ai', ask, asked);
  assert.deepEqual(seen, ['a.example.ai', 'example.ai', 'b.example.ai'], 'a parent two names share is asked once');
  await assert.rejects(registrationOf('www.nowhere.jp', ask), /404/, 'a name no registry holds is unreadable');
  await assert.rejects(registrationOf('x.example.ai', async () => { throw Object.assign(new Error('the registry answered 503'), { status: 503 }); }), /503/, 'any other answer is the error itself, not a parent to try');
});

test('two names under one registration are one domain, and each name no registry holds is its own finding', async () => {
  const ask = async domain => {
    if (domain !== 'example.ai') throw Object.assign(new Error('the registry answered 404'), { status: 404 });
    return { domain, expires: '2099-01-01T00:00:00Z', days_left: 9999 };
  };
  const seen = await checkFromOutside({ address: '127.0.0.1', names: ['a.example.ai', 'b.example.ai', 'www.nowhere.jp'] }, { proxy: '', registry: ask });
  assert.deepEqual(seen.domains.map(found => found.domain), ['example.ai']);
  assert.deepEqual(seen.findings.filter(finding => finding.kind.startsWith('domain-')).map(finding => [finding.kind, finding.about]), [['domain-unreadable', 'www.nowhere.jp']]);
});

test('the row runs the program it packs, reaches the network only through the run\'s proxy and holds no value', () => {
  const row = JSON.parse(readFileSync(new URL('../what-this-tool-does-and-how-to-run-it.json', import.meta.url), 'utf8')).records[0].payload;
  assert.ok(Array.isArray(row.invoke.may_reach));
  assert.equal(row.invoke.key, undefined);
  const packed = row.invoke.files.package_files[0];
  assert.ok(row.invoke.run[1].startsWith(`${packed.at}/`));
  for (const path of packed.paths) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
});
