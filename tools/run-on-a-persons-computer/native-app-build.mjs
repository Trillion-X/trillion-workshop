// Build a saved Sites app on the person's Mac, then keep the output in their Files.
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { runSupervised } from './supervised-run.mjs';
import { fileSource, sendFile } from '../parts/live-namespace/do-work/send-a-file-to-a-namespace.mjs';
import { loadChunking } from '../parts/live-namespace/do-work/content-chunks.mjs';
import { namespaceClient, bearerControl } from '../parts/live-namespace/do-work/namespace-client.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const safeLabel = value => basename(String(value ?? 'App')).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 80) || 'App';

const supervisedBuilder = supervise => async (program, args, { cwd }) => {
  const ran = await supervise({ argv: [program, ...args], cwd, env: process.env, class: 'build' });
  if (ran.timed_out || ran.code !== 0) throw new Error(`The app build did not finish${ran.timed_out ? ` (${ran.said})` : ''}: ${ran.stderr.trim().split('\n').slice(-3).join(' ')}`);
  return ran.stdout;
};

async function build(input = {}, context = {}, deps = {}) {
  const target = input.target;
  const outputKind = input.output_kind ?? 'preview';
  const project = input.project;
  const hosted = project?.source?.kind === 'public-app-installation';
  const connectedXcode = project?.source?.native?.kind === 'xcode-project' && project?.source?.origin?.kind === 'github-repository';
  if (!['ios', 'macos'].includes(target) || !['preview', 'xcode-project'].includes(outputKind) ||
      !project || (!hosted && !connectedXcode)) {
    throw new Error('Choose a saved installed site or a connected Xcode app project.');
  }
  if (connectedXcode) {
    throw new Error('Connected Xcode builds are unavailable until the repository builds in an isolated environment without Mac credentials and a separate signing owner verifies the finished app.');
  }
  if (!context.key || !context.origin) throw new Error('This Mac needs its connected Trillion account to build the current app.');

  const workspace = (deps.makeWorkspace ?? (() => mkdtempSync(join(tmpdir(), 'trillion-sites-app-'))))();
  chmodSync(workspace, 0o700);
  try {
    const bundleId = `com.trillion.sites.${project.id}`;
    const currentInstallation = deps.readInstallation
      ? await deps.readInstallation(project.source.id)
      : await readCurrentInstallation(context.key, project.source.id, deps.fetchImpl ?? fetch);
    const projectPath = join(workspace, 'app-project.json');
    const installationPath = join(workspace, 'current-installation.json');
    writeFileSync(projectPath, JSON.stringify(project), { mode: 0o600, flag: 'wx' });
    writeFileSync(installationPath, JSON.stringify(currentInstallation), { mode: 0o600, flag: 'wx' });
    const builderArgs = [join(repositoryRoot, 'scripts', 'build-native-app.mjs'),
      '--project', projectPath, '--bundle-id', bundleId, '--target', target,
      ...(outputKind === 'preview' ? ['--build'] : []),
      '--current-installation-file', installationPath, '--output-base', workspace];
    // A build runs for minutes: it gets a process of its own, a wall clock, bounded output and the Mac kept awake for as long
    // as it lives (computer/supervised-run.mjs class `build`), instead of holding this host's thread.
    const outputText = await (deps.runBuilder ?? supervisedBuilder(deps.supervise ?? runSupervised))(process.execPath, builderArgs, { cwd: repositoryRoot });
    const result = JSON.parse(outputText.trim().split('\n').at(-1));
    if (result.project_id !== project.id || result.targets !== target || result.built !== (outputKind === 'preview') ||
        typeof result.output !== 'string' || !realpathSync(result.output).startsWith(`${realpathSync(workspace)}${sep}`)) {
      throw new Error('The generated project did not match the checked Sites request.');
    }
    const platformFolder = target === 'ios' ? 'Debug-iphonesimulator' : 'Debug';
    const appPath = join(result.output, 'DerivedData', 'Build', 'Products', platformFolder, `${project.id}.app`);
    if (outputKind === 'preview' && (!existsSync(appPath) || !statSync(appPath).isDirectory())) {
      throw new Error(`The ${target} build did not create its app.`);
    }
    if (outputKind === 'xcode-project') {
      for (const required of ['project.yml', 'AppProject.xcodeproj/project.pbxproj', 'App/HostedApp.swift', 'App/AppProject.json']) {
        if (!existsSync(join(result.output, required))) throw new Error(`The generated Xcode project is missing ${required}.`);
      }
      const embedded = JSON.parse(readFileSync(join(result.output, 'App/AppProject.json'), 'utf8'));
      if (embedded.id !== project.id || embedded.source?.id !== project.source.id ||
          embedded.source?.revision !== project.source.revision) {
        throw new Error('The generated Xcode project does not match the checked Sites source.');
      }
    }
    const archiveName = outputKind === 'xcode-project'
      ? `${safeLabel(project.name)}-${target === 'ios' ? 'iPhone' : 'Mac'}-Xcode-project.zip`
      : `${safeLabel(project.name)}-${target === 'ios' ? 'iPhone-Simulator' : 'Mac'}-unsigned.zip`;
    const archivePath = join(workspace, archiveName);
    (deps.archive ?? ((source, destination) => execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', source, destination], { stdio: 'pipe' })))(
      outputKind === 'xcode-project' ? result.output : appPath, archivePath);

    const client = deps.client ?? namespaceClient({ origin: context.origin,
      control: bearerControl({ origin: context.origin, authorization: async () => `Bearer ${context.key}`, fetchImpl: deps.fetchImpl ?? fetch }),
      fetchImpl: deps.fetchImpl ?? fetch });
    const file = await (deps.fileSource ?? fileSource)(archivePath);
    let saved;
    try {
      saved = await (deps.sendFile ?? sendFile)({ client, source: file,
        chunking: await (deps.loadChunking ?? loadChunking)(),
        name: `/Made by Sites/${archiveName}`, mediaType: 'application/zip' });
    } finally { await file.close(); }
    if (!/^1f:[a-f0-9]{64}$/.test(saved?.identity ?? '')) throw new Error('Your Files did not confirm the app build was saved.');
    return outputKind === 'xcode-project'
      ? { ok: true, target, output_kind: outputKind, name: archiveName, identity: saved.identity,
          signing: 'not-signed', distribution: 'source-project',
          said: 'The Xcode project is saved in your Files. It opens the current published site. Build and sign it with your Apple team before installing or distributing the app.' }
      : { ok: true, target, output_kind: outputKind, name: archiveName, identity: saved.identity,
          signing: 'unsigned', distribution: target === 'ios' ? 'simulator-only' : 'local-mac-only',
          said: target === 'ios'
            ? 'The unsigned iPhone Simulator build is saved in your Files. It is not ready to install on an iPhone.'
            : 'The unsigned Mac app is saved in your Files. Apple signing and distribution are not included.' };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export const nativeAppBuild = { build };

async function readCurrentInstallation(authorization, installationId, fetchImpl) {
  if (!authorization) throw new Error('This Mac needs its connected Trillion account to read the current app.');
  const response = await fetchImpl('https://app.gettrillion.ai/mcp', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { authorization: `Bearer ${authorization}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'read_public_app_installation', arguments: { installation_id: installationId } } }),
  });
  if (!response.ok) throw new Error(`The installed app could not be read (HTTP ${response.status}).`);
  const message = await response.json();
  if (message.error || message.result?.isError || !message.result?.structuredContent) {
    throw new Error('The installed app reader refused this account or returned no current app.');
  }
  return message.result.structuredContent;
}
