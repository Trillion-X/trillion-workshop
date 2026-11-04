// parts/headless-browser/bare-linux.mjs
//
// PURPOSE
//   Make Playwright's Chromium start on a Linux computer where nothing may be installed system-wide (the Cloudflare
//   build that deploys Trillion: Ubuntu 24.04, no root, none of the browser's libraries), and draw the same letters on
//   every run, so pictures taken there compare with pictures taken there before. It sets LD_LIBRARY_PATH and
//   FONTCONFIG_FILE in this process, which Playwright checks a launch against and hands the browser it starts.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing is installed: package files come from the distribution's own archive through apt with its lists and
//      cache kept in `folder`, and are unpacked there with dpkg-deb; no root, no system path is written.
//   2. Which libraries is never typed here: Playwright names the packages its browser needs on this distribution, and
//      whatever library the unpacked ones still lack is found by `ldd` and fetched by its name, until none is missing.
//   3. Only the pinned fonts (bare-linux.json) are visible to the browser, so a font the computer happens to carry
//      never changes a picture.
//   4. Anywhere but Linux this answers null: pictures for comparing are only ever taken here.
//
// SHAPE
//   browserForBareLinux({ root, say }) -> Promise<null | { renderer }>
//     root: the checkout (its git folder holds `folder`); renderer names what draws the pictures (the browser's
//     revision and the fonts), so pictures from another renderer are never compared as if they were the same.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const settings = JSON.parse(readFileSync(new URL('./bare-linux.json', import.meta.url), 'utf8'));
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });

export async function browserForBareLinux({ root, say = () => {} }, { platform = process.platform, run: execute = run, spawn: spawn = spawnSync, env = process.env, chromiumPath = async () => (await import('playwright')).chromium.executablePath() } = {}) {
  if (platform !== 'linux') return null;
  const gitFolder = execute('git', ['rev-parse', '--git-dir'], { cwd: root }).trim();
  const folder = join(root, gitFolder, settings.folder);
  const lists = join(folder, 'lists');
  const cache = join(folder, 'cache');
  const debs = join(folder, 'packages');
  const unpacked = join(folder, 'root');
  for (const path of [join(lists, 'partial'), join(cache, 'archives', 'partial'), debs, unpacked]) mkdirSync(path, { recursive: true });
  const apt = ['-o', `Dir::State::Lists=${lists}`, '-o', `Dir::Cache=${cache}`, '-o', 'Debug::NoLocking=1',
    '-o', 'Acquire::Retries=1', '-o', 'Acquire::http::Timeout=30', '-o', 'Acquire::https::Timeout=30'];
  // Some bare CI images still name Ubuntu's public archives over HTTP. When port 80 cannot reach those mirrors,
  // the visual check waits for each package and never reaches deployment. Keep the image's signed package sources,
  // but use the same archives over HTTPS inside this disposable, unprivileged apt state.
  const ubuntuSources = '/etc/apt/sources.list.d/ubuntu.sources';
  if (existsSync(ubuntuSources)) {
    const sources = join(folder, 'sources');
    mkdirSync(sources, { recursive: true });
    writeFileSync(join(sources, 'ubuntu.sources'), readFileSync(ubuntuSources, 'utf8')
      .replaceAll('http://archive.ubuntu.com/ubuntu', 'https://archive.ubuntu.com/ubuntu')
      .replaceAll('http://security.ubuntu.com/ubuntu', 'https://security.ubuntu.com/ubuntu'));
    apt.push('-o', 'Dir::Etc::sourcelist=/dev/null', '-o', `Dir::Etc::sourceparts=${sources}`);
  }

  execute('npx', ['--no-install', 'playwright', 'install', ...new Set(settings.install ?? [settings.browser])], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const browsers = join(env.PLAYWRIGHT_BROWSERS_PATH ?? join(env.HOME, '.cache', 'ms-playwright'));
  const build = readdirSync(browsers).filter(name => name.startsWith(settings.browser.replace(/-/g, '_'))).sort().at(-1);
  if (!build) throw new Error(`playwright install ${settings.browser} left no browser in ${browsers}`);
  // The program itself: `chrome-headless-shell` (headless_shell in older builds), never a library beside it.
  const executable = readdirSync(join(browsers, build), { recursive: true }).map(String).find(path => /(^|\/)(chrome-headless-shell|headless_shell)$/.test(path));
  if (!executable) throw new Error(`no headless shell program in ${join(browsers, build)}`);
  const binary = join(browsers, build, executable);
  // channel:'chromium' uses the full program (extension guards); the default
  // headless launch uses the shell. Validate and inspect both before any guard.
  const fullBinary = await chromiumPath();
  if (!existsSync(fullBinary)) throw new Error(`playwright install left no full Chromium program at ${fullBinary}`);
  const binaries = [...new Set([binary, fullBinary])];

  // The unpacked libraries sit in the folder named for this computer's architecture (usr/lib/x86_64-linux-gnu).
  const useLibraries = () => {
    const lib = join(unpacked, 'usr', 'lib');
    for (const name of existsSync(lib) ? readdirSync(lib).filter(entry => entry.endsWith('-linux-gnu')) : []) {
      const libraryFolder = join(lib, name);
      if (!(env.LD_LIBRARY_PATH ?? '').split(':').includes(libraryFolder)) env.LD_LIBRARY_PATH = [libraryFolder, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    }
  };
  useLibraries();
  const unpackAll = () => { for (const file of readdirSync(debs).filter(name => name.endsWith('.deb'))) execute('dpkg-deb', ['-x', join(debs, file), unpacked]); useLibraries(); };
  const download = names => { for (const name of names) { try { execute('apt-get', [...apt, 'download', name], { cwd: debs, stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* a name the archive does not carry */ } } };
  const missing = () => {
    const files = [...binaries, ...(existsSync(unpacked) ? readdirSync(unpacked, { recursive: true }).map(String).filter(path => /\.so(\.|$)/.test(path)).map(path => join(unpacked, path)) : [])];
    const lines = files.flatMap(file => { try { return execute('ldd', [file], { env, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n'); } catch { return []; } });
    return [...new Set(lines.filter(line => line.includes('not found')).map(line => line.trim().split(/\s/)[0]))];
  };

  let lacking = missing();
  const fontsReady = existsSync(join(folder, 'fonts.conf'));
  if (lacking.length || !fontsReady) {
    say(`browser: fetching ${lacking.length} missing libraries and the pinned fonts`);
    execute('apt-get', [...apt, 'update'], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (lacking.length) {
      // Playwright prints the packages (as an apt command, or as a list of what is missing) and exits 1 when some are.
      const named = spawn('npx', ['--no-install', 'playwright', 'install-deps', '--dry-run', settings.browser], { cwd: root, encoding: 'utf8' });
      download([...new Set(`${named.stdout}`.split(/[\s"]+/).filter(word => /^lib[a-z0-9.+-]+$/.test(word)))]);
    }
    download(settings.fonts.packages);
    unpackAll();
    // A library one of the unpacked ones still needs, fetched by the package name its file name gives (libXi.so.6 is
    // libxi6, or libxi6t64 since the 64-bit time move), until none is missing.
    for (let round = 0; round < 6 && (lacking = missing()).length; round += 1) {
      download(lacking.flatMap(file => { const name = file.toLowerCase().replace(/\.so\.(\d+).*$/, '$1'); return [name, `${name}t64`]; }));
      unpackAll();
    }
    if (lacking.length) throw new Error(`the browser still lacks ${lacking.join(', ')}, which the archive does not carry under those names`);
    const families = Object.entries(settings.fonts.families)
      .map(([family, face]) => `<alias binding="same"><family>${family}</family><prefer><family>${face}</family></prefer></alias>`).join('');
    writeFileSync(join(folder, 'fonts.conf'), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${join(unpacked, 'usr', 'share', 'fonts')}</dir><cachedir>${join(folder, 'font-cache')}</cachedir>${families}</fontconfig>\n`);
  }
  env.FONTCONFIG_FILE = join(folder, 'fonts.conf');
  const fonts = readdirSync(join(unpacked, 'usr', 'share', 'fonts'), { recursive: true }).map(String).filter(path => /\.(ttf|otf)$/.test(path)).sort();
  return { renderer: { browser: build, fonts } };
}
