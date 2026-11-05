import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { browserForBareLinux } from '../bare-linux.mjs';

function fixture({ omitFull = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'trillion-browser-provision-'));
  const cache = join(root, 'browser-cache');
  const shell = join(cache, 'chromium_headless_shell-1243', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  const full = join(cache, 'chromium-1243', 'chrome-linux64', 'chrome');
  const runtime = join(root, '.git', 'bare-linux-browser');
  const library = join(runtime, 'root', 'usr', 'lib', 'x86_64-linux-gnu', 'libchannel.so.1');
  const commands = [];
  const put = (path, bytes = '') => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes); };
  const env = { HOME: root, PLAYWRIGHT_BROWSERS_PATH: cache, LD_LIBRARY_PATH: '/existing/library' };
  const run = (command, args, options = {}) => {
    commands.push({ command, args, options });
    if (command === 'git') return '.git';
    if (command === 'npx') {
      put(shell);
      if (args.includes('chromium') && !omitFull) put(full);
      return '';
    }
    if (command === 'ldd') return args[0] === full && !existsSync(library) ? 'libchannel.so.1 => not found\n' : '';
    if (command === 'apt-get') {
      if (args.includes('download')) put(join(options.cwd, `${args.at(-1)}.deb`));
      return '';
    }
    if (command === 'dpkg-deb') {
      const name = basename(args[1]);
      if (name.startsWith('libchannel1')) put(library);
      if (name.startsWith('fonts-')) put(join(runtime, 'root', 'usr', 'share', 'fonts', name + '.ttf'));
      return '';
    }
    throw new Error('Unexpected command: ' + command);
  };
  return { root, shell, full, runtime, library, commands, env,
    options: { platform: 'linux', env, run, spawn: () => ({ stdout: 'apt-get install libshell1', stderr: '' }), chromiumPath: async () => full },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('bare Linux prepares both launch modes and resolves a library missing only from full Chromium', async () => {
  const f = fixture();
  try {
    const result = await browserForBareLinux({ root: f.root }, f.options);
    assert.ok(existsSync(f.full), 'channel chromium requires its full executable');
    assert.ok(existsSync(f.shell), 'ordinary headless launches keep their shell');
    assert.ok(existsSync(f.library), 'full-only dependencies must be resolved too');
    const install = f.commands.find(row => row.command === 'npx');
    assert.deepEqual(install.args, ['--no-install', 'playwright', 'install', 'chromium']);
    const inspected = f.commands.filter(row => row.command === 'ldd').map(row => row.args[0]);
    assert.ok(inspected.includes(f.shell)); assert.ok(inspected.includes(f.full));
    assert.equal(result.renderer.browser, 'chromium_headless_shell-1243');
    assert.equal(result.renderer.fonts.length, 2);
    assert.ok(f.env.LD_LIBRARY_PATH.includes('/existing/library'));
    assert.ok(readFileSync(f.env.FONTCONFIG_FILE, 'utf8').includes('DejaVu Sans'));
    assert.ok(f.commands.filter(row => row.command === 'dpkg-deb').every(row => row.args.at(-1).startsWith(f.root)));
  } finally { f.cleanup(); }
});

test('an incomplete install refuses before library provisioning or any browser guard', async () => {
  const f = fixture({ omitFull: true });
  try {
    await assert.rejects(browserForBareLinux({ root: f.root }, f.options), /no full Chromium program/);
    assert.equal(f.commands.some(row => row.command === 'apt-get' || row.command === 'ldd'), false);
  } finally { f.cleanup(); }
});

test('other platforms remain a no-op without browser downloads or environment changes', async () => {
  const f = fixture();
  try {
    assert.equal(await browserForBareLinux({ root: f.root }, { ...f.options, platform: 'darwin' }), null);
    assert.deepEqual(f.commands, []); assert.equal(f.env.FONTCONFIG_FILE, undefined);
  } finally { f.cleanup(); }
});
