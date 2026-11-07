import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const rows = JSON.parse(readFileSync(new URL('../tool-rows.json', import.meta.url), 'utf8'));
const records = rows.records.map(record => record.payload);
const publish = records.find(record => record.id === 'tool:publish-a-download');

test('publishing is an existing-owner computer row with a folder grant and current-user lookup', () => {
  assert.ok(publish);
  assert.equal(publish.status, 'active');
  assert.deepEqual(publish.invoke.capabilities, ['read-a-folder', 'resolve-current-user']);
  assert.equal(publish.invoke.internet, true);
  assert.equal(publish.invoke.capabilities.includes('change-a-folder'), false);
  assert.equal(publish.invoke.capabilities.includes('start-a-program'), false);
  assert.equal(Object.hasOwn(publish.invoke, 'grants'), false, 'the row declares needs; it does not grant itself');

  const { argv } = publish.invoke;
  assert.deepEqual(argv.slice(0, 4), [
    'node',
    '/opt/renew-a-tls-certificate/do-work/renew-a-tls-certificate.mjs',
    'publish',
    '/held/server-administration-key',
  ]);
  assert.deepEqual(argv[4], { fill: { from: 'task', field: 'grants.read-a-folder.folder' } });
});

test('publishing takes one mounted administration key and no DNS key', () => {
  assert.deepEqual(publish.invoke.credential_mounts, [
    { secret_name: 'server-administration-ssh-key', mount_path: '/held/server-administration-key' },
  ]);
});

test('publishing names the relative source file and keeps the existing static-files schema', () => {
  const { input_schema: schema } = publish;
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('file'));
  assert.ok(schema.required.includes('name'));
  assert.match(schema.properties.file.description, /relative path inside the folder/i);
  const existing = records.find(record => record.id === 'tool:read-a-servers-tls-certificate');
  assert.deepEqual(schema.properties.host, existing.input_schema.properties.host);
});

test('every TLS row packages the shared BLAKE3 identity runtime instead of a b3sum executable', () => {
  for (const record of records) {
    const packages = record.invoke.files.package_files;
    assert.ok(packages.some(row => row.package === 'content-identity' && row.paths.includes('read-data')), record.id);
    assert.ok(packages.some(row => row.module === '@noble/hashes' && row.paths.includes('blake3.js')), record.id);
    assert.equal(packages.some(row => row.at?.endsWith('/b3sum')), false, record.id);
  }
});

test('the declared publish package files import and load their helper in isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'renew-tls-row-'));
  try {
    const projectRoot = resolve(dirname(new URL('../tool-rows.json', import.meta.url).pathname), '../..');
    for (const entry of publish.invoke.files.package_files) {
      const sourceRoot = entry.package
        ? resolve(projectRoot, 'tools', entry.package)
        : resolve(projectRoot, 'node_modules', entry.module);
      const destinationRoot = join(root, entry.at.replace(/^\/opt\//, ''));
      for (const path of entry.paths) {
        const source = join(sourceRoot, path);
        const destination = join(destinationRoot, path);
        mkdirSync(dirname(destination), { recursive: true });
        if (statSync(source).isDirectory()) cpSync(source, destination, { recursive: true });
        else copyFileSync(source, destination);
      }
    }

    const modulePath = join(root, 'renew-a-tls-certificate/do-work/renew-a-tls-certificate.mjs');
    const module = await import(new URL(`file://${modulePath}`));
    const file = join(root, 'download', 'App-1.dmg');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'abc');
    let invocation;
    const result = module.publishDownload({
      hostname: 'app.example.com', address: '192.0.2.34', remotePort: 18789,
      knownHostsFile: '/private/known-hosts', adminKeyFile: '/private/admin-key', ssh_port: 22, admin_user: 'admin',
      host: {
        owner: '/usr/local/example/tls-host-owner.py', state: '/etc/example-tls', downloads: '/var/lib/downloads',
        ingress: { service: 'example-tls', pid_file: '/run/example-tls.pid', error_log: '/var/log/example-tls.log' },
        receptionist: { service: 'example-receptionist', account: 'example-mcp', binary_pattern: '/opt/example/[a-f0-9]{40}', listen: '127.0.0.1:9443', paths: ['/mcp'], environment: {} },
      },
    }, file, 'App.dmg', { run: (_command, args, options) => { invocation = { args, options }; return '3\n'; } });
    assert.equal(result.bytes, 3);
    assert.equal(result.blake3.length, 64);
    assert.ok(invocation.args.includes('/usr/bin/python3'));
    assert.ok(invocation.args.some(argument => argument.includes('def publish(')));
    assert.equal(invocation.options.input.toString(), 'abc');
    assert.ok(existsSync(join(root, 'renew-a-tls-certificate/do-work/publish-download.py')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
