import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerCredential, providerCredentialConfiguration, vercelProviderCredential } from './provider-credential.mjs';
import { confirmLiveOrRestore, memoryMegabytesForMeasuredNeed, proveTheReleaseStarts } from './prove-a-release-starts-before-it-goes-live.mjs';
import releaseMachineSettings from '../read-data/release-machine-settings.json' with { type: 'json' };

const RESULT_FILE_NAME = 'deployment-result.json';
const NATIVE_RESULT_FILE_NAME = 'native-deployment-result.json';
const CURRENT_BASE_FILE_NAME = 'current-container-base.json';
export const DEPLOYMENT_RESULT_SCHEMA = 'publication-deployment-result/v1';
const FLY_MACHINES_API = 'https://api.machines.dev/v1';
const CARRIED_CONFIG_FILE = 'fly.current-serving-settings.json';

/** Advance the shared product log through its existing atomic package-delta
 * validator. The host's own account-worker mount declaration selects the log;
 * no caller supplies a path or a command. The request file exists only in this
 * owner's ephemeral workspace and in the host's runtime directory during use. */
export async function applyHostedProductDelta({ application, appId = application, machine, request }, {
  fetchImplementation = fetch,
  readProviderCredential = providerCredential,
  spawnChild = spawn,
  createId = randomUUID,
} = {}) {
  if (typeof application !== 'string' || !IDENTIFIER.test(application)) throw new Error('provider application is invalid');
  if (typeof appId !== 'string' || !IDENTIFIER.test(appId)) throw new Error('installed app identity is invalid');
  if (machine !== undefined && (typeof machine !== 'string' || !PROVIDER_MACHINE.test(machine))) throw new Error('provider machine is invalid');
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || request.schema !== 'bitfield.package_delta/v1'
      || typeof request.partition !== 'string' || !IDENTIFIER.test(request.partition)
      || typeof request.package_ref !== 'string' || !IDENTIFIER.test(request.package_ref)
      || typeof request.proposal_multihash !== 'string' || !request.proposal_multihash.startsWith('1f:')) {
    throw new Error('a compiled package-delta request is required');
  }
  const requestBytes = Buffer.from(JSON.stringify(request));
  if (requestBytes.length > 64 * 1024 * 1024) throw new Error('package delta request exceeds 64 MiB');
  const serving = (await flyMachines(application, readProviderCredential(), fetchImplementation))
    .filter((candidate) => candidate.state === 'started' && candidate.config?.metadata?.purpose !== 'trial-start-of-a-release');
  const selected = machine === undefined
    ? (serving.length === 1 ? serving[0] : null)
    : serving.find((candidate) => candidate.id === machine);
  if (!selected) throw new Error('the selected serving machine is not started');
  const environment = selected.config?.env ?? {};
  let worker;
  let mounts;
  try {
    worker = JSON.parse(environment.BITFIELD_HOSTED_ACCOUNT_WORKER_JSON);
    mounts = JSON.parse(environment.BITFIELD_PROCESS_WORKSPACE_MOUNTS_JSON);
  } catch { throw new Error('the machine has no readable account-worker product mount declaration'); }
  const mount = mounts?.[worker?.product_volume_name];
  if (worker?.package_set !== request.partition || mount?.access !== 'read_only'
      || typeof mount.root !== 'string'
      || !/^\/var\/lib\/bitfield\/[a-z0-9][a-z0-9-]*$/.test(mount.root)) {
    throw new Error('the machine has no matching isolated shared-product log');
  }
  if (environment.BITFIELD_RUNTIME_KIT_HOME !== '/opt/bitfield') throw new Error('the machine has no selected Bitfield runner home');
  const logPath = `${mount.root}/stored-data/envelope.log`;
  const localFolder = mkdtempSync(join(tmpdir(), 'hosted-product-delta-'));
  const localFile = join(localFolder, 'package-delta.json');
  const remoteFile = `/run/bitfield/package-delta-${createId().replace(/[^a-z0-9-]/gi, '')}.json`;
  const common = ['--app', application, '--machine', selected.id];
  const run = async (args) => awaitStep(spawnChild('fly', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv({ env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'] }, process.env),
  }), { writeStdout: () => {}, writeStderr: () => {} });
  let uploadAttempted = false;
  let appliedReceipt = null;
  try {
    const statusCommand = ['env', `BITFIELD_MACHINE_WIDE_HOME=${MACHINE_WIDE_HOME}`,
      INSTALLED_APP_OPENER, '--same-app-id', appId, '--status-report-only'].map(quotedShellToken).join(' ');
    const statusResult = await run(['ssh', 'console', ...common, '--command', statusCommand]);
    let status;
    try { status = JSON.parse(statusResult.stdout); }
    catch { throw new Error('installed app returned no readable status'); }
    const runner = status.requested_process_restart_fingerprint?.executable_inputs?.find(
      (input) => input.name === 'shell-process-role.environment-path.BITFIELD_RUNNER_BINARY');
    const expectedRunnerPath = runner?.multihash?.match(/^1f:[0-9a-f]{64}$/)
      ? `${MACHINE_WIDE_HOME}/.bitfield/runtime-kit/app-log-storage-folders/app-log-storage-for-bitfield-app-${Buffer.from(appId).toString('hex')}/runtime-kit/process-files-by-content-hash/app-state-from-log/bytes-${Buffer.from(runner.multihash).toString('hex')}/bin/bitfield-runner`
      : null;
    if (status.same_app_id !== appId || status.decision !== 'already-open'
        || runner?.path !== expectedRunnerPath || !Number.isSafeInteger(runner.byte_length)
        || runner.byte_length < 1) {
      throw new Error('the installed app has no current signed runner');
    }
    writeFileSync(localFile, requestBytes, { mode: 0o600, flag: 'wx' });
    uploadAttempted = true;
    await run(['ssh', 'sftp', 'put', localFile, remoteFile, ...common, '--mode', '0600']);
    const command = [
      runner.path,
      '--apply-package-delta-to-log', logPath,
      '--partition', request.partition,
      '--request-file', remoteFile,
    ].map(quotedShellToken).join(' ');
    const result = await run(['ssh', 'console', ...common, '--command', command]);
    const receiptLine = result.stdout.split('\n').map((line) => line.trim()).find((line) => line.startsWith('{'));
    let receipt;
    try { receipt = JSON.parse(receiptLine); }
    catch { throw new Error('host package-delta writer returned no JSON receipt'); }
    if (receipt.schema !== 'bitfield.package_delta_receipt/v1'
        || receipt.partition !== request.partition
        || receipt.package_ref !== request.package_ref
        || receipt.proposal_multihash !== request.proposal_multihash
        || receipt.outcome !== 'applied') {
      throw new Error(`host package-delta writer did not apply the selected package: ${receipt.reason_code ?? receipt.outcome ?? 'invalid receipt'}`);
    }
    appliedReceipt = receipt;
    return receipt;
  } finally {
    rmSync(localFolder, { recursive: true, force: true });
    if (uploadAttempted) {
      try {
        await run(['ssh', 'console', ...common, '--command', `rm -f ${quotedShellToken(remoteFile)}`]);
      } catch (error) {
        if (appliedReceipt === null) throw error;
        process.stderr.write(`package delta applied; temporary host input cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
}

/** Invoke the installed engine's guarded operation against the host-selected
 * shared product log. Customer workers only read this log; the host owns writes. */
export async function invokeHostedProductLogOperation({ application, machine, request }, {
  fetchImplementation = fetch,
  readProviderCredential = providerCredential,
  spawnChild = spawn,
  createId = randomUUID,
} = {}) {
  if (typeof application !== 'string' || !IDENTIFIER.test(application)) throw new Error('provider application is invalid');
  if (machine !== undefined && (typeof machine !== 'string' || !PROVIDER_MACHINE.test(machine))) throw new Error('provider machine is invalid');
  if (!request || typeof request !== 'object' || Array.isArray(request)
      || !['engine.operation.read-current', 'engine.operation.write-batch', 'engine.operation.refresh-derived-state'].includes(request.operation_label)) {
    throw new Error('a guarded label-addressed engine operation is required');
  }
  const requestBytes = Buffer.from(JSON.stringify(request));
  if (requestBytes.length > 8 * 1024 * 1024) throw new Error('product operation exceeds 8 MiB');
  const serving = (await flyMachines(application, readProviderCredential(), fetchImplementation))
    .filter((candidate) => candidate.state === 'started' && candidate.config?.metadata?.purpose !== 'trial-start-of-a-release');
  const selected = machine === undefined
    ? (serving.length === 1 ? serving[0] : null)
    : serving.find((candidate) => candidate.id === machine);
  if (!selected) throw new Error('the selected serving machine is not started');
  const environment = selected.config?.env ?? {};
  let worker;
  let mounts;
  try {
    worker = JSON.parse(environment.BITFIELD_HOSTED_ACCOUNT_WORKER_JSON);
    mounts = JSON.parse(environment.BITFIELD_PROCESS_WORKSPACE_MOUNTS_JSON);
  } catch { throw new Error('the machine has no readable account-worker product mount declaration'); }
  const mount = mounts?.[worker?.product_volume_name];
  if (worker?.package_set !== application || mount?.access !== 'read_only'
      || typeof mount.root !== 'string'
      || !/^\/var\/lib\/bitfield\/[a-z0-9][a-z0-9-]*$/.test(mount.root)
      || environment.BITFIELD_RUNTIME_KIT_HOME !== '/opt/bitfield') {
    throw new Error('the machine has no matching isolated shared-product log');
  }
  const folder = mkdtempSync(join(tmpdir(), 'hosted-product-operation-'));
  const id = createId().replace(/[^a-z0-9-]/gi, '');
  const localRequest = join(folder, 'request.json');
  const localReply = join(folder, 'reply.json');
  const remoteRequest = `/run/bitfield/product-operation-${id}.json`;
  const remoteReply = `/run/bitfield/product-operation-${id}-reply.json`;
  const common = ['--app', application, '--machine', selected.id];
  const run = async (args) => {
    let diagnostic = '';
    try {
      return await awaitStep(spawnChild('fly', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv({ env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'] }, process.env),
      }), { writeStdout: () => {}, writeStderr: (chunk) => { diagnostic += chunk; } });
    } catch (error) {
      throw new Error(`host product ${args[1]} failed: ${diagnostic.slice(-500) || error.message}`);
    }
  };
  let uploaded = false;
  try {
    writeFileSync(localRequest, requestBytes, { mode: 0o600, flag: 'wx' });
    uploaded = true;
    await run(['ssh', 'sftp', 'put', localRequest, remoteRequest, ...common, '--mode', '0600']);
    const command = [
      '/opt/bitfield/bin/bitfield-stored-data', 'engine-operation',
      '--log-path', `${mount.root}/stored-data/envelope.log`,
      '--partition', worker.package_set,
      '--request-file', remoteRequest,
      '--output', remoteReply,
      '--label-addressed',
      ...(request.operation_label === 'engine.operation.write-batch' ? ['--fill-expected-current'] : []),
    ].map(quotedShellToken).join(' ');
    if (request.operation_label !== 'engine.operation.refresh-derived-state') {
      await run(['ssh', 'console', ...common, '--command', command]);
    }
    if (request.operation_label !== 'engine.operation.read-current') {
      const policyCommand = [
        'env', `BITFIELD_MACHINE_WIDE_HOME=${MACHINE_WIDE_HOME}`,
        INSTALLED_APP_OPENER, '--same-app-id', worker.package_set,
        '--print-process-admission-policy',
      ].map(quotedShellToken).join(' ');
      const policyResult = await run(['ssh', 'console', ...common, '--command', policyCommand]);
      const policyText = policyResult.stdout.trim();
      if (policyText.length === 0 || policyText.length > 1024 * 1024) {
        throw new Error('installed app returned no bounded process admission policy');
      }
      let policy;
      try { policy = JSON.parse(policyText); }
      catch { throw new Error('installed app returned no readable process admission policy'); }
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        throw new Error('installed app returned no process admission policy object');
      }
      const refreshCommand = [
        'env', `BITFIELD_PROCESS_ADMISSION_POLICY_JSON=${JSON.stringify(policy)}`,
        '/opt/bitfield/bin/bitfield-runner', '--refresh-derived-state-in-log',
        `${mount.root}/stored-data/envelope.log`, '--partition', worker.package_set,
      ].map(quotedShellToken).join(' ');
      await run(['ssh', 'console', ...common, '--command', refreshCommand]);
    }
    if (request.operation_label === 'engine.operation.refresh-derived-state') {
      return { operation_label: request.operation_label, outcome: 'refreshed' };
    }
    await run(['ssh', 'sftp', 'get', remoteReply, localReply, ...common]);
    return JSON.parse(readFileSync(localReply, 'utf8'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
    if (uploaded) {
      try {
        await run(['ssh', 'console', ...common, '--command', `rm -f ${quotedShellToken(remoteRequest)} ${quotedShellToken(remoteReply)}`]);
      } catch { /* The host's runtime scratch is cleaned on restart. */ }
    }
  }
}

async function openTrialTunnel({ application, privateIp }) {
  if (!/^fdaa:[0-9a-f:]+$/i.test(privateIp)) throw new Error('trial machine has no private address');
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => server.once('error', rejectListen).listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  const child = spawn('fly', ['proxy', `${port}:8080`, privateIp, '-a', application, '--quiet'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolveReady, rejectReady) => {
      let output = '';
      const timer = setTimeout(() => rejectReady(new Error('trial tunnel did not start')), 10_000);
      const onData = (bytes) => {
        output += String(bytes);
        if (output.includes('Proxying localhost:')) {
          clearTimeout(timer);
          resolveReady();
        }
        if (output.length > 2_000) output = output.slice(-2_000);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (error) => { clearTimeout(timer); rejectReady(error); });
      child.once('exit', (code) => { clearTimeout(timer); rejectReady(new Error(`trial tunnel exited ${code}: ${output.slice(-300)}`)); });
    });
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
  return { port, close: () => child.kill('SIGTERM') };
}

const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;
const PROVIDER_MACHINE = /^[0-9a-f]{14}$/;
const ENVIRONMENT_VALUE = /^[^\0]*$/;
const FLY_VM_SIZE = /^(?:shared-cpu|performance)-[1-9][0-9]*x$/;
const FLY_MEMORY_MEGABYTES = /^[1-9][0-9]{2,5}$/;

function parameter(parameters, name, pattern) {
  const value = parameters?.[name];
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`deployment profile parameter ${name} is invalid`);
  }
  return value;
}

/** Provider effects are generic-package behavior. Package sets select one
 * profile and provide bounded values; they cannot provide a command, arguments,
 * environment names, or parsing code. Adding a provider changes this owner. */
export function packageOwnedDeploymentPlan(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new Error('deployment request must be an object');
  const allowed = ['kind', 'schema', 'profile', 'parameters'];
  if (Object.keys(descriptor).some((key) => !allowed.includes(key))) {
    throw new Error('deployment request may contain only kind, schema, profile, and parameters');
  }
  // `kind` is what this descriptor claims to be, and it is checked. The
  // `schema` field beside it was checked too, against one exact string ending
  // in an ordinal. It said nothing `kind` had not already said: both are
  // constants the caller writes, so a caller that gets one right gets the
  // other right, and a caller that gets one wrong is already refused.
  //
  // What it DID do was make the set of acceptable descriptors a closed list of
  // one, so publishing a second package set meant writing that ordinal again,
  // and an ordinal is a number standing in for a meaning: two generations can
  // exist at once with nothing saying how they differ. The field is still
  // ACCEPTED, so the set already published under it keeps working untouched;
  // it is simply no longer the gate.
  if (descriptor.kind !== 'package-owned-deployment-request'
      || !descriptor.parameters
      || typeof descriptor.parameters !== 'object'
      || Array.isArray(descriptor.parameters)
      || Object.entries(descriptor.parameters).length > 16
      || Object.entries(descriptor.parameters).some(([key, value]) => !key || typeof value !== 'string' || !value)) {
    throw new Error('deployment request does not match the package-owned request contract');
  }
  const parameters = descriptor.parameters ?? {};
  switch (descriptor.profile) {
    case 'fly-append-image-layer': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      const baseImage = parameter(parameters, 'base_image', /^registry\.fly\.io\/[a-z0-9][a-z0-9-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/);
      const image = parameter(parameters, 'image', /^registry\.fly\.io\/[a-z0-9][a-z0-9-]*:[A-Za-z0-9._-]+$/);
      const layerFile = parameter(parameters, 'layer_file', /^[A-Za-z0-9._-]+\.tar$/);
      if (!baseImage.startsWith(`registry.fly.io/${application}:`) || !image.startsWith(`registry.fly.io/${application}:`) || baseImage === image) {
        throw new Error('signed layer images must be distinct tags for the same application');
      }
      return {
        site_root: 'required',
        steps: [
          { current_image: baseImage, application },
          { command: 'fly', args: ['auth', 'docker'] },
          { command: 'crane', args: ['append', '--base', baseImage, '--new_layer', layerFile, '--new_tag', image] },
        ],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: { strategy: 'registry-image', image },
      };
    }
    case 'fly-machine-image': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      const machine = parameter(parameters, 'machine', PROVIDER_MACHINE);
      const image = parameter(parameters, 'image', /^registry\.fly\.io\/[a-z0-9][a-z0-9-]*:[A-Za-z0-9._-]+$/);
      if (!image.startsWith(`registry.fly.io/${application}:`)) throw new Error('machine image belongs to another application');
      return {
        steps: [{ command: 'fly', args: ['machine', 'update', machine, '--image', image, '--app', application, '--skip-health-checks', '--yes'] }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: { strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev', vars: { app_name: application } },
      };
    }
    case 'fly-built-image-trial': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      const image = `registry.fly.io/${application}:{release_label}`;
      return {
        site_root: 'required',
        steps: [
          { carry: 'current-serving-settings', application, config_file: CARRIED_CONFIG_FILE },
          { command: 'fly', args: ['deploy', '--app', application, '--config', CARRIED_CONFIG_FILE,
            '--dockerfile', 'Dockerfile', '--remote-only', '--build-only', '--push',
            '--image-label', '{release_label}', '--yes'] },
          { proof: 'the-release-starts', application, image },
          { command: 'fly', args: ['deploy', '--app', application, '--config', CARRIED_CONFIG_FILE,
            '--image', image, '--yes', '--now'] },
        ],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN', 'FLY_CONFIG_DIR'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-prebuilt-image': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      const image = parameter(parameters, 'image', /^registry\.fly\.io\/[a-z0-9][a-z0-9-]*:release-[a-z0-9]+$/);
      if (!image.startsWith(`registry.fly.io/${application}:`)) {
        throw new Error('prebuilt image does not belong to the application');
      }
      return {
        site_root: 'not-required',
        steps: [
          { carry: 'current-serving-settings', application, config_file: CARRIED_CONFIG_FILE },
          { proof: 'the-release-starts', application, image },
          { command: 'fly', args: ['deploy', '--config', CARRIED_CONFIG_FILE, '--app', application, '--image', image, '--yes', '--now'] },
        ],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-remote-only': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      // `config_file` is OPTIONAL, and that is a correctness fix rather than a
      // convenience. An app's configuration, meaning its hostnames, its volume,
      // its environment and its machine size, is a fact the provider already
      // holds and keeps current. Requiring a file here made every caller
      // transcribe that fact by hand before it could deploy, which is a
      // snapshot with a hidden expiry: identical in shape to a true config, and
      // silently stale the moment anything changes it at the provider. Worse,
      // the transcription is one app's identity, so the file could only ever be
      // written by someone naming a specific app inside a generic package's
      // caller. Omitted, the provider deploys against its own stored config and
      // no copy exists to drift. A caller that genuinely owns a config file in
      // its publication workspace still passes one.
      const configFile = parameters?.config_file === undefined
        ? null
        : parameter(parameters, 'config_file', RELATIVE_PATH);
      // A provider's build cache is an optimization the provider owns, and it
      // can be WRONG: a cached layer whose compressed blob the builder can no
      // longer produce fails every export, identically, forever, so a retry is
      // not a fix and the deploy is simply stuck. `reuse_build_cache: "no"` is
      // the way to say "build it again from nothing" without a caller reaching
      // past this owner to type provider flags. It is a bounded enumeration of
      // two states rather than a free-text flag, so it cannot become a channel
      // for arbitrary provider arguments.
      const reuseBuildCache = parameters?.reuse_build_cache === undefined
        ? 'yes'
        : parameter(parameters, 'reuse_build_cache', /^(?:yes|no)$/);
      // This provider runs TWO build services, and they are not equally able.
      // The managed one is the default and it can fail to export an image
      // whose base layers it cannot recompress, which reports as a missing
      // compression blob and fails identically on every retry and with the
      // cache disabled, so neither patience nor a cache flag reaches it. The
      // other service builds on a machine in the account itself and does not
      // share that limit. Which service builds is therefore a real choice a
      // deploy has to be able to express, and it is DATA rather than a flag a
      // caller types, because only this owner knows what either name means to
      // this provider. Two bounded states, so it cannot carry arbitrary
      // provider arguments.
      const buildService = parameters?.build_service === undefined
        ? 'provider-managed'
        : parameter(parameters, 'build_service', /^(?:provider-managed|in-account|local)$/);
      const vmSize = parameters?.vm_size === undefined
        ? null
        : parameter(parameters, 'vm_size', FLY_VM_SIZE);
      const memoryMegabytes = parameters?.memory_megabytes === undefined
        ? null
        : parameter(parameters, 'memory_megabytes', FLY_MEMORY_MEGABYTES);
      if ((vmSize === null) !== (memoryMegabytes === null)) {
        throw new Error('fly-remote-only requires vm_size and memory_megabytes together');
      }
      // A deploy re-applies the provider's STORED machine size, and that
      // stored size beats the size flags: an app whose stored config said
      // 4 GB came back at 4 GB after every deploy that asked for 8 GB, and was
      // killed for memory. So a stated size is asserted again AFTER the deploy,
      // through the same instrument `fly-machine-size` uses, which also makes
      // it the stored size for the next deploy.
      //
      // The image is BUILT and pushed first and released second, with a trial
      // start between them (`prove-a-release-starts-before-it-goes-live.mjs`),
      // so a version that cannot fully start is refused before any live
      // machine is touched. `{release_label}` is filled once per run.
      const candidateImage = `registry.fly.io/${application}:{release_label}`;
      //
      // A release must not change HOW the app is served either. `fly deploy`
      // re-applies the provider's STORED service settings, so a machine that
      // was told to stay running (idle stop off, because every cold start gave
      // a visitor a minute of 502s) went back to stopping when idle at the next
      // release. With no config file named, the stored config is read and the
      // live machines' serving settings and size are written over it, and
      // every deploy command uses that file.
      const releaseConfig = configFile ?? CARRIED_CONFIG_FILE;
      return {
        site_root: 'required',
        steps: [...(configFile === null ? [{ carry: 'current-serving-settings', application, config_file: CARRIED_CONFIG_FILE }] : []), {
          command: 'fly',
          args: [
            'deploy',
            '--config', releaseConfig,
            ...(reuseBuildCache === 'no' ? ['--no-cache'] : []),
            ...(buildService === 'in-account' ? ['--depot=false'] : []),
            '--app', application, buildService === 'local' ? '--local-only' : '--remote-only', '--build-only', '--push',
            '--image-label', '{release_label}',
          ],
        }, {
          proof: 'the-release-starts', application, image: candidateImage,
        }, {
          command: 'fly',
          args: [
            'deploy',
            '--config', releaseConfig,
            ...(vmSize === null ? [] : ['--vm-size', vmSize, '--vm-memory', memoryMegabytes]),
            '--app', application, '--image', candidateImage, '--yes', '--now',
          ],
        }, ...(vmSize === null ? [] : [{
          command: 'fly',
          args: ['scale', 'vm', vmSize, '--memory', memoryMegabytes, '--app', application],
        }])],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-restart': {
      // RESTARTING IS NOT REBUILDING, and it belongs here rather than in a
      // sibling file, because a second place that mutates a hosting provider
      // is a second deployment road however small it is.
      //
      // Converging packages and DATA changes what a running app HOLDS. It does
      // not change what a long-lived process is still serving from memory, and
      // a machine can stay up for days. The native executable has not changed
      // in that case, so replacing the image would be the wrong and far more
      // expensive instrument.
      //
      // Naming no instance restarts EVERY instance, which is the honest
      // reading of "restart this app" and what a caller who does not track
      // machine identities means. Restarting one arbitrary instance instead
      // would leave the app half on its old state with nothing saying so.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const instance = parameters?.instance === undefined
        ? null
        : parameter(parameters, 'instance', IDENTIFIER);
      return {
        steps: [{
          command: 'fly',
          args: instance
            ? ['machine', 'restart', instance, '--app', application]
            : ['apps', 'restart', application],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-retire-machine': {
      // ONE instance goes away and NOTHING else does. An app-level retirement
      // takes the volumes with it, so a machine that has to be removed while
      // its application keeps serving needs an instrument that cannot reach
      // the application or its storage even by mistake.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const machine = parameter(parameters, 'machine', PROVIDER_MACHINE);
      return {
        steps: [{
          command: 'fly',
          args: ['machine', 'destroy', machine, '--app', application, '--force'],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-installed-app-status': {
      // ASKING WHAT THE INSTALLED APP THINKS IT IS DOING, and nothing else.
      // The command is assembled here from one application and one app
      // identity, so a package set naming a `command` changes nothing: a
      // remote shell a caller can fill in is not a status read.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const appId = parameter(parameters, 'app_id', IDENTIFIER);
      const machine = parameters.machine === undefined ? null
        : parameter(parameters, 'machine', PROVIDER_MACHINE);
      return {
        steps: [{
          command: 'fly',
          args: ['ssh', 'console', '--app', application,
            ...(machine ? ['--machine', machine] : []), '--command', [
            'env',
            `BITFIELD_MACHINE_WIDE_HOME=${MACHINE_WIDE_HOME}`,
            INSTALLED_APP_OPENER,
            '--same-app-id',
            appId,
            '--status-report-only',
          ].map(quotedShellToken).join(' ')],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-machine-environment': {
      // ONE named value on ONE instance. The name and the value are bounded
      // separately because only the name can become provider syntax; the value
      // is a person's data and travels as one argument whatever it contains.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const machine = parameter(parameters, 'machine', PROVIDER_MACHINE);
      const environmentName = parameter(parameters, 'environment_name', ENVIRONMENT_NAME);
      const environmentValue = parameter(parameters, 'environment_value', ENVIRONMENT_VALUE);
      return {
        steps: [{
          command: 'fly',
          args: [
            'machine', 'update', machine,
            '--env', `${environmentName}=${environmentValue}`,
            '--app', application, '--yes',
          ],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-machine-memory': {
      // HOW MUCH MEMORY THE MACHINES GET, as its own instrument.
      //
      // Releasing an image resets a machine to the size the app declares, so
      // a size set by hand silently disappears the next time anything ships.
      // That failure is invisible until the moment it is not: the app starts,
      // prints that it is serving, and is then OOM-killed part-way through
      // opening its log, which reads from outside as a hang rather than as a
      // memory limit. Recovering needs this to be one bounded action rather
      // than a rebuild.
      //
      // The size is validated as a plain megabyte count, so this profile can
      // only ever change how much memory the app has.
      // The CPU class comes with the size and cannot be set apart from it:
      // a shared machine refuses more than 4096 MB whatever is asked, so
      // recovering a machine that used to be larger means naming both.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const megabytes = parameter(parameters, 'megabytes', /^[1-9][0-9]{2,5}$/);
      const vmSize = parameters?.vm_size === undefined
        ? null
        : parameter(parameters, 'vm_size', /^(shared-cpu|performance)-[1-8]x$/);
      return {
        steps: [{
          command: 'fly',
          args: vmSize
            ? ['scale', 'vm', vmSize, '--memory', megabytes, '--app', application]
            : ['scale', 'memory', megabytes, '--app', application],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-application-state': {
      // IS IT RUNNING, AND IF NOT, WHAT DID IT SAY ON THE WAY DOWN.
      //
      // Every other profile here CHANGES the app, so the only way to learn
      // its state was to change it again and read what came back. That is how
      // a restart becomes a diagnostic instrument, which is exactly backwards:
      // a restart destroys the evidence of why the app was unhealthy, and an
      // app that is merely slow gets an outage instead of an answer.
      //
      // `status` answers whether the provider believes it is running, and
      // `logs` answers what the process itself said. Neither writes anything.
      // They are one profile because a state question is almost never one of
      // the two alone: "it is stopped" is only useful beside the reason.
      const application = parameter(parameters, 'application', IDENTIFIER);
      return {
        steps: [
          { command: 'fly', args: ['status', '--app', application] },
          { command: 'fly', args: ['logs', '--app', application, '--no-tail'] },
        ],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-runtime-diagnostics': {
      // The public log can say only that the runtime child exited because the
      // child keeps its exact refusal in its installation-owned stderr file.
      // Read that one file directly. Pointer and policy reads are separate
      // questions; putting them first meant either could prevent the diagnostic
      // the caller actually requested.
      const application = parameter(parameters, 'application', IDENTIFIER);
      return {
        steps: [
          {
            command: 'fly',
            args: [
              'ssh', 'console', '--app', application, '--command',
              "find /var/lib/bitfield -type f -name 'bitfield-runner-stderr.latest.log' -exec tail -200 {} \\;",
            ],
          },
        ],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-native-process-state': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      return {
        steps: [{ command: 'fly', args: ['ssh', 'console', '--app', application,
          '--command', "find /proc -maxdepth 2 -name stat -exec cat {} \\;"] }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-native-process-wait': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      const pid = parameter(parameters, 'pid', /^[1-9][0-9]{0,8}$/);
      return {
        steps: [{ command: 'fly', args: ['ssh', 'console', '--app', application,
          '--command', `cat /proc/${pid}/wchan`] }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-offline-refresh-cancel': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      const pid = parameter(parameters, 'pid', /^[1-9][0-9]{0,8}$/);
      return {
        steps: [{ command: 'fly', args: ['ssh', 'console', '--app', application,
          '--command', `/bin/sh -c 'kill -TERM ${pid}'`] }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-secret-names': {
      // WHICH SECRETS DOES THIS APP HOLD, answered without any value leaving
      // the provider.
      //
      // Every sibling profile here SETS a secret, so a caller who needs to
      // know whether one is already present has only one move available:
      // set it again. That is the wrong instrument twice over. It needs a
      // value the caller may not have, and it restarts the app to write a
      // secret that may already be identical, which is an outage bought for
      // an answer that was free.
      //
      // The provider reports names and digests, never values, so this is a
      // read an agent may run and report in full. A digest is enough to tell
      // "absent" from "present" and to tell one rotation from another, which
      // is every question a deployment actually asks about a secret.
      const application = parameter(parameters, 'application', IDENTIFIER);
      return {
        steps: [{
          command: 'fly',
          args: ['secrets', 'list', '--app', application],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-secret-from-environment': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      const secretName = parameter(parameters, 'secret_name', /^[A-Z][A-Z0-9_]{1,127}$/);
      return {
        steps: [{
          command: 'fly',
          args: ['secrets', 'import', '--app', application],
          stdin_from_environment: {
            name: secretName,
            prefix: `${secretName}=`,
            suffix: '\n',
          },
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-secret-from-handed-secret': {
      // A SECRET THIS PROCESS IS HANDED, from wherever it already lives.
      //
      // The sibling profile above can only take a secret from this process's
      // ENVIRONMENT, and the one below it only from one named provider. That
      // leaves every secret that already exists somewhere else on the machine
      // with no road at all: a value in a vault, in a file another tool owns,
      // or on the output of a command that knows how to fetch it. The gap is
      // not theoretical, it is the common case, and the workaround it pushes a
      // caller toward is to set an environment variable in front of a command,
      // which is exactly the construct that lets an environment name a PROGRAM
      // rather than a value and is refused for that reason.
      //
      // So this profile is deliberately BLIND to where the secret came from.
      // It reads the bytes handed to this process on its own standard input and
      // hands them to the provider. A vault reader, a file, a credential helper
      // and a password manager all compose with it without this owner learning
      // any of their names, and no secret is ever written into a command line,
      // an argument, or a file this owner has to be trusted with.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const secretName = parameter(parameters, 'secret_name', /^[A-Z][A-Z0-9_]{1,127}$/);
      return {
        steps: [{
          command: 'fly',
          args: ['secrets', 'import', '--app', application],
          stdin_from_handed_secret: {
            prefix: `${secretName}=`,
            suffix: '\n',
          },
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'copy-provider-environment-secret': {
      const sourceProvider = parameter(parameters, 'source_provider', /^vercel$/);
      const sourceProject = parameter(parameters, 'source_project', /^prj_[A-Za-z0-9]{8,96}$/);
      const sourceOrganization = parameter(parameters, 'source_organization', /^(?:team_|user_)[A-Za-z0-9]{8,96}$/);
      const sourceEnvironment = parameter(parameters, 'source_environment', /^(?:production|preview|development)$/);
      const sourceSecretName = parameter(parameters, 'source_secret_name', /^[A-Z][A-Z0-9_]{1,127}$/);
      const destinationProvider = parameter(parameters, 'destination_provider', /^fly$/);
      const destinationApplication = parameter(parameters, 'destination_application', IDENTIFIER);
      const destinationSecretName = parameter(parameters, 'destination_secret_name', /^[A-Z][A-Z0-9_]{1,127}$/);
      return {
        secret_source: {
          provider: sourceProvider,
          project: sourceProject,
          organization: sourceOrganization,
          environment: sourceEnvironment,
          name: sourceSecretName,
          destination_name: destinationSecretName,
        },
        steps: [{
          command: destinationProvider,
          args: ['secrets', 'import', '--app', destinationApplication],
          stdin_from_environment: {
            name: destinationSecretName,
            prefix: `${destinationSecretName}=`,
            suffix: '\n',
          },
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: destinationApplication },
        },
      };
    }
    case 'fly-machine-size': {
      // HOW MUCH MACHINE AN APP NEEDS IS A DEPLOYMENT FACT, so it belongs to the
      // one owner that reaches this provider. Measured here: opening an app read
      // its installed closure and reached 1.9GB, the machine had 2GB, and the
      // platform killed it one second in, every boot. Nothing in the app was
      // wrong and nothing in the app could fix it.
      //
      // Memory is a number rather than a bounded list because there is no such
      // thing as a wrong-in-principle size, but it is checked as a plain number
      // within what this provider actually offers, so it can never carry an
      // argument through to the provider.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const memoryMegabytes = parameter(parameters, 'memory_megabytes', /^[1-9][0-9]{2,5}$/);
      const instance = parameters?.instance === undefined
        ? null
        : parameter(parameters, 'instance', IDENTIFIER);
      // MEMORY IS NOT FREELY CHOSEN ON THIS PROVIDER; it is bounded by how many
      // cores the machine has, and asking for more than the current class
      // allows is refused with the ceiling rather than honoured. So the class
      // has to be sayable here, or the owner can only reach sizes that happen
      // to fit what somebody chose earlier. Which class is the caller's, since
      // only the caller knows what the work needs; the shape is checked so it
      // stays a name and can never become another argument.
      const machineClass = parameters?.machine_class === undefined
        ? null
        : parameter(parameters, 'machine_class', /^[a-z][a-z0-9-]{2,30}$/);
      return {
        steps: [{
          command: 'fly',
          args: machineClass
            ? [
              'scale', 'vm', machineClass, '--memory', memoryMegabytes, '--app', application,
              ...(instance ? ['--group', instance] : []),
            ]
            : [
              'scale', 'memory', memoryMegabytes, '--app', application,
              ...(instance ? ['--group', instance] : []),
            ],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-image-release': {
      // RELEASING AN IMAGE THE PROVIDER ALREADY HOLDS, with no build and no
      // context upload. Every other profile that changes what runs has to send
      // the whole build context first, and for an app whose bundle is over a
      // gigabyte that is twenty minutes during which the app stays broken.
      //
      // The need is not speed, it is REACH. An image already in the provider's
      // registry is a known-good artifact that needs no producer to still
      // work: the checkout that built it may have moved on, its build route
      // may have been retired, the builder may be unhealthy. Measured here,
      // all three were true at once while a customer-facing app restarted
      // every thirty-one seconds, and the only thing standing between it and
      // service was that this owner could deploy, restart, resize and retire
      // but could not say "run that one again".
      //
      // The image reference is checked as a reference and can never become
      // another argument. It names a registry, a repository and a tag or
      // digest, which is exactly what the provider already published.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const image = parameter(
        parameters,
        'image',
        /^[a-z0-9][a-z0-9._-]*(?:\.[a-z0-9._-]+)*(?:\/[a-z0-9][a-z0-9._-]*)+(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]{64})?$/,
      );
      return {
        steps: [{
          command: 'fly',
          args: ['deploy', '--app', application, '--image', image, '--yes', '--now'],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-volume-size': {
      // HOW MUCH STORAGE AN APP NEEDS IS A DEPLOYMENT FACT, the sibling of
      // machine size above and owned here for the same reason. Measured: an
      // install of a 1.3GB app bundle refused after nineteen seconds on a
      // volume with 2.6GB free, because the machine retains the current
      // bundle, its predecessor and ITS predecessor, so a fourth generation
      // has to fit beside three. Nothing in the app was wrong and nothing in
      // the app could fix it, and the refusal reached the log as an exit code
      // with no account, because the machine reboots before the tail ships.
      //
      // Size is a plain number of gigabytes within what this provider offers,
      // so it can never carry an argument through. A volume can only ever grow
      // on this provider, which is a property of the provider rather than a
      // rule invented here; a smaller number is refused by it, loudly.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const volume = parameter(parameters, 'volume', /^[a-z0-9_]{3,40}$/);
      const sizeGigabytes = parameter(parameters, 'size_gigabytes', /^[1-9][0-9]{0,4}$/);
      return {
        steps: [{
          command: 'fly',
          args: ['volumes', 'extend', volume, '--size', sizeGigabytes, '--app', application, '--yes'],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-retire-volume': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      const volume = parameter(parameters, 'volume', /^vol_[a-z0-9]{8,32}$/);
      return {
        steps: [{ command: 'fly', args: ['volumes', 'destroy', volume, '--app', application, '--yes'] }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-machine-kernel-security-modules': {
      // WHICH SECURITY MODULES THE HOST KERNEL RUNS IS A DEPLOYMENT FACT, and until now nothing
      // could say it. Measured here: the process authority enforces filesystem containment on
      // Linux through Landlock, and this provider's kernel answered its very first query with
      // "Function not implemented", so every contained process died at the exec barrier and the
      // installation could not run anyone's work. Nothing in the app was wrong and nothing in the
      // app could fix it, which is the same shape as the memory ceiling above.
      //
      // The list replaces the kernel's built-in module stack rather than adding to it, so a caller
      // names the whole stack it wants. It is checked as one bounded token list so it can never
      // carry another provider argument, and the machine is named because this provider applies
      // the setting per machine.
      const application = parameter(parameters, 'application', IDENTIFIER);
      const machine = parameter(parameters, 'machine', /^[0-9a-f]{6,32}$/);
      const modules = parameter(parameters, 'security_modules', /^[a-z][a-z0-9]*(?:,[a-z][a-z0-9]*){0,15}$/);
      return {
        steps: [{
          command: 'fly',
          args: [
            'machine', 'update', machine,
            '--kernel-arg', `lsm=${modules}`,
            '--app', application, '--skip-health-checks', '--yes',
          ],
        }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'fly-retire-application': {
      // TAKING AN APP OFF THE PROVIDER IS A DEPLOYMENT FACT TOO, and the only
      // reason it was missing is that nobody had needed it from this owner. The
      // consequence was measured: a second app whose whole log was six rows and
      // two dead offers billed a 10GB volume and a running machine for a month
      // after the product it was for stopped existing, because the one road
      // that reaches this provider could deploy, restart and resize but never
      // remove. A road that can only add is a bill that can only grow.
      //
      // Removing the app removes its volumes with it; the provider keeps a
      // snapshot of each volume on its own retention, which is the provider's
      // fact and is read from the provider rather than copied here.
      const application = parameter(parameters, 'application', IDENTIFIER);
      return {
        steps: [{ command: 'fly', args: ['apps', 'destroy', application, '--yes'] }],
        env_passthrough: ['HOME', 'PATH', 'FLY_API_TOKEN'],
        result_extraction: {
          strategy: 'fixed-hostname', hostname_template: 'https://{app_name}.fly.dev',
          vars: { app_name: application },
        },
      };
    }
    case 'vercel-prebuilt-production':
      return {
        site_root: 'required',
        steps: [{ command: 'npx', args: ['--yes', 'vercel@56.4.1', 'deploy', '--prebuilt', '--prod', '--yes'] }],
        env_passthrough: ['PATH', 'VERCEL_TOKEN'],
        result_extraction: { strategy: 'one-https-url-on-stdout', source: 'stdout' },
      };
    case 'railway-service': {
      const application = parameter(parameters, 'application', IDENTIFIER);
      const domain = parameter(parameters, 'domain', /^[a-z0-9.-]+$/);
      return {
        site_root: 'required',
        steps: [{ command: 'railway', args: ['up', '--service', application, '--detach'] }],
        env_passthrough: ['PATH', 'RAILWAY_TOKEN'],
        result_extraction: { strategy: 'fixed-hostname', hostname_template: 'https://{domain}', vars: { domain } },
      };
    }
    default:
      throw new Error(`deployment profile is not owned by hosted-public-app: ${String(descriptor.profile)}`);
  }
}

function noResultFile(unlink, file) {
  try {
    unlink(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function canonicalDeploymentUrl(candidate) {
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.port !== ''
    || parsed.hostname === ''
    || candidate.includes('?')
    || candidate.includes('#')
  ) {
    return null;
  }
  return parsed.href;
}

/** Executable provider behavior is produced only by packageOwnedDeploymentPlan. */
function releaseSteps(descriptor) {
  if (Array.isArray(descriptor.steps)) {
    if (descriptor.command !== undefined || descriptor.args !== undefined) {
      throw new Error('release descriptor declares both steps and command/args');
    }
    if (descriptor.steps.length === 0) throw new Error('release descriptor steps must be non-empty');
    return descriptor.steps.map((step, index) => releaseStep(step, `steps[${index}]`));
  }
  return [releaseStep(descriptor, 'release')];
}

function releaseStep(step, label) {
  if (!step || typeof step !== 'object') throw new Error(`${label} must be an object`);
  if (step.current_image !== undefined) {
    if (!IDENTIFIER.test(step.application ?? '') || typeof step.current_image !== 'string') {
      throw new Error(`${label} is not a current-image check`);
    }
    return { current_image: step.current_image, application: step.application };
  }
  // Two steps are this owner's own code rather than a provider command: the
  // trial start that must pass before a release, and reading the serving
  // settings a release must keep. Only this owner's plan can produce them.
  if (step.proof !== undefined) {
    if (step.proof !== 'the-release-starts' || !IDENTIFIER.test(step.application ?? '') || typeof step.image !== 'string') {
      throw new Error(`${label} is not a known proof`);
    }
    return { proof: step.proof, application: step.application, image: step.image };
  }
  if (step.carry !== undefined) {
    if (step.carry !== 'current-serving-settings' || !IDENTIFIER.test(step.application ?? '')
        || !RELATIVE_PATH.test(step.config_file ?? '')) {
      throw new Error(`${label} is not a known carry`);
    }
    return { carry: step.carry, application: step.application, configFile: step.config_file };
  }
  if (typeof step.command !== 'string' || step.command === '') {
    throw new Error(`${label}.command must be a non-empty string`);
  }
  if (step.args !== undefined && !Array.isArray(step.args)) {
    throw new Error(`${label}.args must be an array when present`);
  }
  const args = (step.args ?? []).map((arg, index) => {
    if (typeof arg !== 'string') throw new Error(`${label}.args[${index}] must be a string`);
    return arg;
  });
  let stdinFromEnvironment;
  if (step.stdin_from_environment !== undefined) {
    const input = step.stdin_from_environment;
    if (
      !input || typeof input !== 'object'
      || typeof input.name !== 'string' || !/^[A-Z][A-Z0-9_]{1,127}$/.test(input.name)
      || typeof input.prefix !== 'string'
      || typeof input.suffix !== 'string'
    ) {
      throw new Error(`${label}.stdin_from_environment is invalid`);
    }
    stdinFromEnvironment = input;
  }
  let stdinFromHandedSecret;
  if (step.stdin_from_handed_secret !== undefined) {
    const input = step.stdin_from_handed_secret;
    if (
      !input || typeof input !== 'object'
      || typeof input.prefix !== 'string'
      || typeof input.suffix !== 'string'
    ) {
      throw new Error(`${label}.stdin_from_handed_secret is invalid`);
    }
    stdinFromHandedSecret = input;
  }
  // One step takes its secret from one source. Accepting both would make the
  // precedence between them a silent rule nobody states, and the losing source
  // would look configured while doing nothing.
  if (stdinFromEnvironment && stdinFromHandedSecret) {
    throw new Error(`${label} declares two secret sources`);
  }
  return {
    command: step.command,
    args,
    ...(stdinFromEnvironment ? { stdinFromEnvironment } : {}),
    ...(stdinFromHandedSecret ? { stdinFromHandedSecret } : {}),
  };
}

/** Credential values arrive from the already-vault-resolved parent process. */
function childEnv(descriptor, parentEnv) {
  if (descriptor.env_passthrough === undefined) return parentEnv;
  if (!Array.isArray(descriptor.env_passthrough)) throw new Error('release descriptor env_passthrough must be an array');
  const env = {};
  for (const [index, name] of descriptor.env_passthrough.entries()) {
    if (typeof name !== 'string' || name === '') throw new Error(`env_passthrough[${index}] must be a non-empty string`);
    if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  }
  return env;
}

function extractionSource(rule, streams) {
  const source = rule.source ?? 'stdout';
  if (source === 'stdout') return streams.stdout;
  if (source === 'stderr') return streams.stderr;
  if (typeof source === 'string' && source.startsWith('output_file:')) {
    const mount = source.slice('output_file:'.length);
    if (!mount) throw new Error('result_extraction.source output_file has no mount path');
    return streams.readFile(mount);
  }
  throw new Error(`result_extraction.source is not a supported source: ${String(source)}`);
}

function fillTemplate(template, vars) {
  if (typeof template !== 'string' || template === '') throw new Error('result_extraction.hostname_template must be a non-empty string');
  const map = vars ?? {};
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key) => {
    const value = map[key];
    if (typeof value !== 'string' || value === '') throw new Error(`result_extraction.vars.${key} is missing for hostname_template`);
    return value;
  });
}

/** Result extraction belongs to the package-owned provider plan. */
export function deploymentResultFromExtraction(rule, streams) {
  if (!rule || typeof rule !== 'object') throw new Error('release descriptor result_extraction must be an object');
  if (rule.strategy === 'registry-image') return { schema: 'published-container-image/v1', image: rule.image };
  let share_url;
  switch (rule.strategy) {
    case 'one-https-url-on-stdout': {
      const text = extractionSource(rule, streams);
      const urls = (text.match(/https:\/\/[^\s]+/g) ?? [])
        .map(canonicalDeploymentUrl)
        .filter((url) => url !== null);
      if (urls.length !== 1) throw new Error('deploy must report exactly one valid deployment URL');
      share_url = urls[0];
      break;
    }
    case 'regex-capture': {
      if (typeof rule.pattern !== 'string' || rule.pattern === '') throw new Error('result_extraction.pattern is required for regex-capture');
      const match = extractionSource(rule, streams).match(new RegExp(rule.pattern));
      const captured = match?.[1];
      share_url = captured ? canonicalDeploymentUrl(captured) : null;
      if (!share_url) throw new Error('regex-capture did not yield exactly one canonical deployment URL');
      break;
    }
    case 'jsonpath': {
      if (typeof rule.pattern !== 'string' || rule.pattern === '') throw new Error('result_extraction.pattern is required for jsonpath');
      let parsed;
      try { parsed = JSON.parse(extractionSource(rule, streams)); }
      catch { throw new Error('jsonpath source is not valid JSON'); }
      let cursor = parsed;
      for (const key of rule.pattern.split('.')) {
        if (cursor === null || typeof cursor !== 'object') { cursor = undefined; break; }
        cursor = cursor[key];
      }
      share_url = typeof cursor === 'string' ? canonicalDeploymentUrl(cursor) : null;
      if (!share_url) throw new Error('jsonpath did not resolve to a canonical deployment URL');
      break;
    }
    case 'fixed-hostname': {
      share_url = canonicalDeploymentUrl(fillTemplate(rule.hostname_template, rule.vars));
      if (!share_url) throw new Error('fixed-hostname produced a non-canonical deployment URL');
      break;
    }
    default:
      throw new Error(`result_extraction.strategy is not supported: ${String(rule?.strategy)}`);
  }
  return { schema: DEPLOYMENT_RESULT_SCHEMA, share_url };
}

function writeResultAtomically({ resultFile: file, result, writeFile, rename, unlink, createId }) {
  const temporaryFile = `${file}.${createId()}.tmp`;
  try {
    writeFile(temporaryFile, `${JSON.stringify(result)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    rename(temporaryFile, file);
  } catch (error) {
    noResultFile(unlink, temporaryFile);
    throw error;
  }
}

function awaitStep(child, { writeStdout, writeStderr }) {
  return new Promise((resolveStep, reject) => {
    if (!child?.stdout?.on || !child?.stderr?.on || !child?.once) {
      reject(new Error('deploy process did not expose piped output streams'));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      writeStdout(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      writeStderr(chunk);
    });
    child.once('error', fail);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`deploy step exited ${code ?? `from signal ${signal ?? 'unknown'}`}`));
        return;
      }
      resolveStep({ stdout, stderr });
    });
  });
}

/** The secret handed to this process on its own standard input, read once.
 * A producer may hand it as a bare value or as `NAME=value`; both are what the
 * tools that already hold secrets emit, and refusing one of them would send a
 * caller back to reshaping a secret in a shell pipeline. */
export function handedSecretValue(handedSecret, expectedName) {
  const text = String(handedSecret ?? '').replace(/\r?\n$/, '');
  if (text.length === 0) throw new Error('no secret was handed to this process on its input');
  if (text.includes('\n') || text.includes('\r')) {
    throw new Error('the handed secret is not one line');
  }
  const assignment = text.startsWith(`${expectedName}=`) ? text.slice(expectedName.length + 1) : text;
  if (assignment.length === 0) throw new Error('the handed secret has no value');
  // A DIFFERENT name on the left of `=` means the producer handed the wrong
  // secret, and importing it under the requested name would store the wrong
  // value under a trusted name without anything saying so.
  if (assignment === text && /^[A-Z][A-Z0-9_]{1,127}=/.test(text)) {
    throw new Error(`the handed secret names ${text.split('=', 1)[0]}, not ${expectedName}`);
  }
  return assignment;
}

function secretInputForStep(step, parentEnv, handedSecret) {
  if (step.stdinFromHandedSecret) {
    const { prefix, suffix } = step.stdinFromHandedSecret;
    const expectedName = prefix.endsWith('=') ? prefix.slice(0, -1) : prefix;
    // Read the stream this process was handed only when a step asked for it,
    // and only if a value was not already supplied for a test. Reading it up
    // front would make every unrelated deployment wait on a pipe nobody wrote
    // to, which is indistinguishable from a deployment that is still working.
    const handed = handedSecret === null || handedSecret === undefined
      ? readFileSync(0, 'utf8')
      : handedSecret;
    return `${prefix}${handedSecretValue(handed, expectedName)}${suffix}`;
  }
  if (!step.stdinFromEnvironment) return null;
  const { name, prefix, suffix } = step.stdinFromEnvironment;
  const value = parentEnv[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`deployment secret environment ${name} is missing`);
  }
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`deployment secret environment ${name} is not one line`);
  }
  return `${prefix}${value}${suffix}`;
}

export async function providerEnvironmentSecret(source, {
  token,
  fetchImplementation = fetch,
} = {}) {
  if (!source || source.provider !== 'vercel') {
    throw new Error('environment secret source provider is not supported');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Vercel provider credential is missing');
  }
  const url = new URL(
    `/v3/env/pull/${encodeURIComponent(source.project)}/${encodeURIComponent(source.environment)}`,
    'https://api.vercel.com',
  );
  url.searchParams.set('source', 'hosted-public-app:copy-provider-environment-secret');
  url.searchParams.set('teamId', source.organization);
  const response = await fetchImplementation(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response?.ok) {
    throw new Error(`Vercel environment read failed with status ${String(response?.status ?? 'unknown')}`);
  }
  const result = await response.json();
  const value = result?.env?.[source.name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Vercel environment secret ${source.name} is missing`);
  }
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`Vercel environment secret ${source.name} is not one line`);
  }
  return value;
}

/** Test seam for the package-owned provider plan. */
function withReleaseLabel(step, releaseLabel) {
  const fill = (value) => (typeof value === 'string' ? value.replaceAll('{release_label}', releaseLabel) : value);
  if (step.proof) return { ...step, image: fill(step.image) };
  if (step.args) return { ...step, args: step.args.map(fill) };
  return step;
}

/**
 * The provider's stored config with the LIVE machines' serving settings and
 * size and application environment written over it. The machine may have a
 * legitimate host-role value installed after the last image release; dropping
 * it makes the next image serve the wrong page. Provider-generated process and
 * region values stay with the provider rather than becoming app config.
 */
export function configWithCurrentServingSettings(stored, machines) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new Error('the provider returned no stored config to release against');
  }
  const serving = (machines ?? []).filter((machine) => machine?.config?.metadata?.fly_process_group
    && machine?.config?.metadata?.purpose !== 'trial-start-of-a-release');
  const live = serving[0]?.config;
  if (!live) return stored;
  const carried = { ...stored };
  const liveEnv = live.env && typeof live.env === 'object' && !Array.isArray(live.env)
    ? Object.fromEntries(Object.entries(live.env).filter(([key]) => !['FLY_PROCESS_GROUP', 'PRIMARY_REGION'].includes(key)))
    : {};
  carried.env = { ...(stored.env ?? {}), ...liveEnv };
  for (const retired of releaseMachineSettings.environment_no_longer_read ?? []) delete carried.env[retired];
  const service = (live.services ?? [])[0];
  if (service && carried.http_service && typeof carried.http_service === 'object') {
    carried.http_service = {
      ...carried.http_service,
      auto_stop_machines: service.autostop ?? carried.http_service.auto_stop_machines,
      auto_start_machines: service.autostart ?? carried.http_service.auto_start_machines,
      min_machines_running: service.min_machines_running ?? carried.http_service.min_machines_running,
    };
  }
  const guest = live.guest;
  if (guest && typeof guest.memory_mb === 'number' && typeof guest.cpus === 'number' && typeof guest.cpu_kind === 'string') {
    carried.vm = [{ memory: `${guest.memory_mb}mb`, cpu_kind: guest.cpu_kind, cpus: guest.cpus }];
  }
  return carried;
}

/**
 * The carried config with its machine memory taken from what the release
 * measurably needed on its trial start, in either direction. The CPU kind and
 * count stay as they are. Unmeasured need leaves the config unchanged.
 */
export function configSizedFromMeasuredNeed(config, measured, settings = releaseMachineSettings) {
  const vm = Array.isArray(config?.vm) ? config.vm[0] : null;
  const previous = typeof vm?.memory === 'string' ? Number.parseInt(vm.memory, 10) : null;
  const memory = vm ? memoryMegabytesForMeasuredNeed({ measured, cpuKind: vm.cpu_kind, cpus: vm.cpus }, settings) : null;
  if (memory === null) return { config, memory_megabytes: null, previous_megabytes: previous, need_bytes: null };
  return {
    config: { ...config, vm: [{ ...vm, memory: `${memory}mb` }, ...config.vm.slice(1)] },
    memory_megabytes: memory,
    previous_megabytes: previous,
    need_bytes: measured.memory_in_use_bytes + (measured.opener_peak_bytes ?? 0),
  };
}

export async function runProviderDeployment({
  descriptor,
  spawnChild,
  parentEnv,
  spawnOptionsBase = { stdio: ['ignore', 'pipe', 'pipe'] },
  resultFile: file,
  writeStdout = (chunk) => process.stdout.write(chunk),
  writeStderr = (chunk) => process.stderr.write(chunk),
  fs = { writeFile: writeFileSync, rename: renameSync, unlink: unlinkSync, readFile: (path) => readFileSync(path, 'utf8') },
  createId = randomUUID,
  fetchImplementation = fetch,
  readVercelCredential = vercelProviderCredential,
  readProviderCredential = providerCredential,
  proveRelease = proveTheReleaseStarts,
  releaseMemberReadiness = null,
  expectedServingImage = null,
  readCurrentServingImage = async (application, credential, fetchImplementation) => {
    const machines = currentServingFlyMachines(await flyMachines(application, credential, fetchImplementation));
    return machines[0].config.image;
  },
  confirmRelease = confirmLiveOrRestore,
  handedSecret = null,
}) {
  const plan = packageOwnedDeploymentPlan(descriptor);
  if (descriptor.profile === 'fly-built-image-trial'
      && (!releaseMemberReadiness
        || releaseMemberReadiness.application !== descriptor.parameters?.application
        || !releaseMemberReadiness.storage
        || typeof releaseMemberReadiness.authenticatedSelector !== 'string'
        || !releaseMemberReadiness.authenticatedSelector.trim()
        || !Array.isArray(releaseMemberReadiness.journeys)
        || releaseMemberReadiness.journeys.length === 0)) {
    throw new Error('a matching signed-in member journey is required before this container can be released');
  }
  // One label per run names the image that is built, tried and released, so
  // the thing that passed the trial is exactly the thing that goes live.
  const releaseLabel = `release-${String(createId()).replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`;
  const steps = releaseSteps(plan).map((step) => withReleaseLabel(step, releaseLabel));
  let executionEnv = parentEnv;
  if (plan.secret_source) {
    const secret = await providerEnvironmentSecret(plan.secret_source, {
      token: parentEnv.VERCEL_TOKEN ?? readVercelCredential(),
      fetchImplementation,
    });
    executionEnv = { ...parentEnv, [plan.secret_source.destination_name]: secret };
  }
  const env = childEnv(plan, executionEnv);
  if (file !== null) noResultFile(fs.unlink, file);
  try {
    let stdout = '';
    let stderr = '';
    let proof = null;
    let carriedConfigFile = null;
    const workingDirectory = spawnOptionsBase.cwd ?? process.cwd();
    const runCommand = async (command, args) => {
      const child = spawnChild(command, args, { ...spawnOptionsBase, env });
      return awaitStep(child, { writeStdout, writeStderr });
    };
    const readMachineCommand = async ({ application, machineId, command }) => {
      const result = await runCommand('fly', ['ssh', 'console', '--app', application,
        '--machine', machineId, '--command', command.map(quotedShellToken).join(' ')]);
      return { stdout: result.stdout };
    };
    for (const step of steps) {
      if (step.current_image) {
        const currentImage = await readCurrentServingImage(step.application, readProviderCredential(), fetchImplementation);
        if (currentImage !== step.current_image) throw new Error('serving image changed before signed layer publication');
        const layer = resolve(workingDirectory, descriptor.parameters.layer_file);
        if (dirname(layer) !== workingDirectory || !lstatSync(layer).isFile() || lstatSync(layer).isSymbolicLink()) {
          throw new Error('signed layer must be an ordinary file in the publication workspace');
        }
        continue;
      }
      if (step.carry) {
        carriedConfigFile = step.configFile;
        const shown = await runCommand('fly', ['config', 'show', '--app', step.application]);
        const machines = await flyMachines(step.application, readProviderCredential(), fetchImplementation);
        const carried = configWithCurrentServingSettings(JSON.parse(shown.stdout), machines);
        fs.writeFile(resolve(workingDirectory, step.configFile), `${JSON.stringify(carried, null, 2)}\n`);
        continue;
      }
      if (step.proof) {
        proof = await proveRelease({
          application: step.application, image: step.image, credential: readProviderCredential(),
          fetchImplementation, openTrialTunnel, memberReadiness: releaseMemberReadiness,
          machineCommand: readMachineCommand,
        });
        const currentImage = await readCurrentServingImage(step.application, readProviderCredential(), fetchImplementation);
        if (expectedServingImage !== null && proof.previous_image !== expectedServingImage) {
          throw new Error('serving image changed since the reviewed deployment was composed');
        }
        if (currentImage !== proof.previous_image) {
          throw new Error('serving image changed during release trial; refusing to replace a newer release');
        }
        writeStderr(`[release] trial start: live ${proof.live.ready ? 'ready' : `not ready (${proof.live.reason})`}, new version ${proof.trial.ready ? 'ready' : `not ready (${proof.trial.reason})`}\n`);
        if (carriedConfigFile !== null) {
          const configPath = resolve(workingDirectory, carriedConfigFile);
          const carried = JSON.parse(fs.readFile(configPath));
          const sized = configSizedFromMeasuredNeed(carried, proof.measured);
          if (sized.memory_megabytes !== null) {
            fs.writeFile(configPath, `${JSON.stringify(sized.config, null, 2)}\n`);
            writeStderr(`[release] machine memory ${sized.previous_megabytes} MB -> ${sized.memory_megabytes} MB from a measured need of ${Math.round(sized.need_bytes / 1048576)} MB\n`);
          }
        }
        continue;
      }
      const secretInput = secretInputForStep(step, executionEnv, handedSecret);
      const child = spawnChild(step.command, step.args, {
        ...spawnOptionsBase,
        ...(secretInput === null ? {} : { stdio: ['pipe', 'pipe', 'pipe'] }),
        env,
      });
      if (secretInput !== null) {
        if (!child?.stdin?.end) throw new Error('deploy process did not expose a piped input stream');
        child.stdin.end(secretInput);
      }
      const streams = await awaitStep(child, { writeStdout, writeStderr });
      stdout += streams.stdout;
      stderr += streams.stderr;
    }
    if (proof) {
      const releaseArgs = steps.find((step) => step.command === 'fly' && step.args.includes('--image'))?.args ?? [];
      await confirmRelease({
        proof,
        credential: readProviderCredential(),
        fetchImplementation,
        machineCommand: readMachineCommand,
        restore: async (previousImage) => {
          const args = releaseArgs.map((arg, index) => (releaseArgs[index - 1] === '--image' ? previousImage : arg));
          await runCommand('fly', args);
        },
      });
    }
    const result = deploymentResultFromExtraction(plan.result_extraction, {
      stdout,
      stderr,
      readFile: (mount) => fs.readFile(mount),
    });
    if (file !== null) writeResultAtomically({ resultFile: file, result, ...fs, createId });
    return result;
  } catch (error) {
    if (file !== null) noResultFile(fs.unlink, file);
    throw error;
  }
}

export function deploymentRequestFromArgs(argv, workspaceRoot = process.cwd()) {
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const inline = argv.indexOf('--request');
  if (inline === -1 || argv[inline + 1] === undefined) throw new Error('--request requires a JSON value');
  const descriptor = JSON.parse(argv[inline + 1]);
  const plan = packageOwnedDeploymentPlan(descriptor);
  return { descriptor, siteRoot: selectedSiteRoot(argv, canonicalWorkspace, plan) };
}

/** Provider operations that only mutate provider state have no build context.
 * Requiring a directory for restart or machine sizing made callers invent one,
 * even though no command reads it. File-producing deploy profiles still get one
 * contained direct child and keep the existing traversal/symlink checks. */
function selectedSiteRoot(argv, canonicalWorkspace, plan) {
  const supplied = argv.includes('--site-root');
  if (plan.site_root === 'required') return siteRootFromArgs(argv, canonicalWorkspace);
  if (supplied) throw new Error('this provider operation does not accept a site root');
  return null;
}

/** The containment check both descriptor forms share. It lives in one function
 * so the inline form cannot drift into a weaker check than the file form. */
function siteRootFromArgs(argv, canonicalWorkspace) {
  const siteFlag = argv.indexOf('--site-root');
  if (siteFlag === -1 || argv[siteFlag + 1] === undefined) {
    throw new Error('run-provider-deploy requires --site-root <path>');
  }
  const requestedSite = resolve(canonicalWorkspace, argv[siteFlag + 1]);
  const siteMetadata = lstatSync(requestedSite);
  if (siteMetadata.isSymbolicLink() || !siteMetadata.isDirectory()) {
    throw new Error('site root must be an ordinary directory');
  }
  const siteRoot = realpathSync(requestedSite);
  if (dirname(siteRoot) !== canonicalWorkspace) {
    throw new Error('site root must be a direct child of the contained publication workspace');
  }
  return siteRoot;
}

function tarText(bytes) {
  return bytes.toString('utf8').replace(/\0.*$/s, '').trim();
}

function tarNumber(bytes, label) {
  const text = tarText(bytes);
  if (!/^[0-7]+$/.test(text)) throw new Error(`container artifact ${label} is invalid`);
  return Number.parseInt(text, 8);
}

/** Extract the owner-produced, uncompressed tar without invoking a second
 * executable. Provider CLIs are selected only as top-level compute runtimes;
 * a Node child can never smuggle one through ambient PATH. */
export function extractContainerArtifact(archiveBytes, destination) {
  let offset = 0;
  const root = resolve(destination);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  while (offset + 512 <= archiveBytes.length) {
    const header = archiveBytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return;
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const archivePath = `${prefix ? `${prefix}/` : ''}${name}`.replace(/^\.\//, '');
    const size = tarNumber(header.subarray(124, 136), 'size');
    const mode = tarNumber(header.subarray(100, 108), 'mode') & 0o777;
    const kind = String.fromCharCode(header[156] || 48);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > archiveBytes.length) throw new Error('container artifact is truncated');
    if (kind === 'x' || kind === 'g') {
      offset = next;
      continue;
    }
    if (!archivePath || archivePath === '.') {
      offset = next;
      continue;
    }
    if (archivePath.startsWith('/') || archivePath.split('/').some((part) => part === '..')) {
      throw new Error('container artifact path escapes its deployment workspace');
    }
    const target = resolve(root, archivePath);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error('container artifact path escapes its deployment workspace');
    }
    if (kind === '5') {
      mkdirSync(target, { recursive: true, mode: mode || 0o755 });
      chmodSync(target, mode || 0o755);
    } else if (kind === '0') {
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      writeFileSync(target, archiveBytes.subarray(offset + 512, offset + 512 + size), { mode: mode || 0o644 });
      chmodSync(target, mode || 0o644);
    } else {
      throw new Error(`container artifact entry type ${kind} is not admitted`);
    }
    offset = next;
  }
  throw new Error('container artifact has no end marker');
}

function writeEphemeralFlyCredential(workspaceRoot, configuration = providerCredentialConfiguration()) {
  const directory = resolve(workspaceRoot, 'fly-config');
  // The workspace's owner-private parent is the security boundary. These two
  // descendants must be readable by the pinned provider image, whose declared
  // user is not required to share the host creator's uid. A host-only 0700/0600
  // pair makes the credential exist while making it unreadable to the process
  // it was created for; fly then reports the misleading "no access token".
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  chmodSync(directory, 0o755);
  writeFileSync(resolve(directory, 'config.yml'), configuration, {
    encoding: 'utf8', mode: 0o644, flag: 'wx',
  });
}

export function nativeContainerDeploymentRequestFromArgs(argv, workspaceRoot = process.cwd(), options = {}) {
  const artifactFlag = argv.indexOf('--prepare-container-artifact');
  if (artifactFlag === -1) return null;
  const applicationFlag = argv.indexOf('--application');
  const application = argv[applicationFlag + 1];
  if (applicationFlag === -1 || typeof application !== 'string' || !IDENTIFIER.test(application)) {
    throw new Error('--application requires one semantic provider application');
  }
  const canonicalWorkspace = realpathSync(workspaceRoot);
  const artifactArgument = argv[artifactFlag + 1];
  if (typeof artifactArgument !== 'string') throw new Error('--prepare-container-artifact requires one file');
  const artifactFile = resolve(canonicalWorkspace, artifactArgument);
  const artifactMetadata = lstatSync(artifactFile);
  if (artifactMetadata.isSymbolicLink() || !artifactMetadata.isFile() || dirname(realpathSync(artifactFile)) !== canonicalWorkspace) {
    throw new Error('container artifact must be one ordinary direct child of the contained deployment workspace');
  }
  const siteRoot = resolve(canonicalWorkspace, 'site');
  extractContainerArtifact(readFileSync(artifactFile), siteRoot);
  if (!existsSync(resolve(siteRoot, 'Dockerfile'))) throw new Error('container artifact has no Dockerfile');
  // The provider runtime receives the deployable site workspace. Keep its
  // short-lived credential inside that same contained workspace so the
  // provider can read it without exposing a host path or relying on ambient
  // environment state.
  const credentialConfiguration = options.credentialConfiguration
    ?? (options.credential === undefined
      ? providerCredentialConfiguration()
      : `access_token: ${options.credential}\nlast_login: 1970-01-01T00:00:00Z\n`);
  writeEphemeralFlyCredential(siteRoot, credentialConfiguration);
  return {
    application,
    descriptor: {
      kind: 'package-owned-deployment-request',
      profile: 'fly-remote-only',
      parameters: { application },
    },
    siteRoot,
  };
}

async function flyMachines(application, credential = providerCredential(), fetchImplementation = fetch) {
  const response = await fetchImplementation(`${FLY_MACHINES_API}/apps/${application}/machines`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  if (!response.ok) throw new Error(`provider machine read failed with ${response.status}`);
  const machines = await response.json();
  if (!Array.isArray(machines)) throw new Error('provider returned no machine list');
  return machines;
}


function currentFlyMachineShape(machine) {
  const guest = machine?.config?.guest;
  const cpuKind = guest?.cpu_kind;
  const cpus = guest?.cpus;
  const memoryMegabytes = guest?.memory_mb;
  const vmSize = `${cpuKind === 'shared' ? 'shared-cpu' : cpuKind}-${String(cpus)}x`;
  if ((cpuKind !== 'shared' && cpuKind !== 'performance')
      || !Number.isInteger(cpus) || !Number.isInteger(memoryMegabytes)
      || !FLY_VM_SIZE.test(vmSize)
      || !FLY_MEMORY_MEGABYTES.test(String(memoryMegabytes))) {
    throw new Error('provider returned no supported current machine CPU and memory shape');
  }
  return {
    vm_size: vmSize,
    memory_megabytes: memoryMegabytes,
  };
}

function uniformCurrentFlyMachineShape(machines) {
  const shape = currentFlyMachineShape(machines[0]);
  for (const machine of machines.slice(1)) {
    const candidate = currentFlyMachineShape(machine);
    if (candidate.vm_size !== shape.vm_size
        || candidate.memory_megabytes !== shape.memory_megabytes) {
      throw new Error('provider returned machines with different current CPU or memory shapes');
    }
  }
  return shape;
}

function currentServingFlyMachines(machines) {
  const serving = machines.filter((machine) => machine?.config?.metadata?.purpose !== 'trial-start-of-a-release');
  if (serving.length === 0) throw new Error('provider returned no serving machine');
  const images = new Set(serving.map((machine) => machine?.config?.image));
  if (images.size !== 1 || images.has(undefined)) {
    throw new Error('provider returned serving machines with different current images');
  }
  return serving;
}

async function bootCatalog(application, fetchImplementation, wait, attempts) {
  let lastStatus = 'unavailable';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImplementation(`https://${application}.fly.dev/boot`);
      lastStatus = String(response.status ?? (response.ok ? 200 : 'unavailable'));
      if (response.ok) return response.json();
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < attempts) await wait(5_000);
  }
  throw new Error(`deployed application boot read failed: ${lastStatus}`);
}

export async function nativeContainerDeploymentResult(application, options = {}) {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const machines = currentServingFlyMachines(await flyMachines(application, options.credential ?? providerCredential(), fetchImplementation));
  const wait = options.wait ?? ((milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
  const boot = await bootCatalog(application, fetchImplementation, wait, options.bootAttempts ?? 36);
  const targets = Array.isArray(boot) ? boot : Array.isArray(boot?.targets) ? boot.targets : [];
  const machine = machines[0];
  return {
    provider_application: application,
    image: machine?.config?.image ?? null,
    release: machine?.config?.metadata?.fly_release_version ?? null,
    machine: machine?.id ?? null,
    boot_healthy: targets.length > 0,
    boot_target_count: targets.length,
  };
}

const MACHINE_SIZE_ARGUMENTS = 7;

/** Resizing is one bounded instrument, so the command carries exactly the
 * application and the shape it is being given, and nothing that could become
 * a second provider operation. */
export function machineSizeRequestFromArgs(argv) {
  if (!argv.includes('--set-machine-size')) return null;
  if (argv.length !== MACHINE_SIZE_ARGUMENTS) {
    throw new Error('setting a machine size accepts exactly one application, CPU shape and memory count');
  }
  const named = (flag) => argv[argv.indexOf(flag) + 1];
  const application = named('--provider-application');
  const vmSize = named('--vm-size');
  const megabytes = named('--memory-megabytes');
  if (typeof application !== 'string' || !IDENTIFIER.test(application)) {
    throw new Error('provider application is invalid');
  }
  if (typeof vmSize !== 'string' || !FLY_VM_SIZE.test(vmSize)) throw new Error('vm_size is invalid');
  if (typeof megabytes !== 'string' || !FLY_MEMORY_MEGABYTES.test(megabytes)) {
    throw new Error('memory_megabytes is invalid');
  }
  return {
    kind: 'package-owned-deployment-request',
    profile: 'fly-machine-memory',
    parameters: { application, vm_size: vmSize, megabytes },
  };
}

/** Every token is quoted whole, so a value carrying a newline, a quote, a
 * semicolon or a substitution reaches the far side as ONE argument and can
 * never become a second command. The value is a person's data, not syntax. */
function quotedShellToken(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

const MACHINE_WIDE_HOME = '/var/lib/bitfield';
const INSTALLED_APP_OPENER = '/opt/bitfield/bin/open-bitfield-app';
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]*$/;
const INSTALLED_APP_ENVIRONMENT_ARGUMENTS = 9;

/** One installed application's log-owned process environment, advanced through
 * the opener that already owns it. This assembles the command only; running it
 * and restarting afterwards belong to the declared deployment steps. */
export function installedAppProcessEnvironmentCommandsFromArgs(argv) {
  if (!argv.includes('--prepare-installed-app-process-environment')) return null;
  if (argv.length !== INSTALLED_APP_ENVIRONMENT_ARGUMENTS) {
    throw new Error('advancing an installed process environment accepts exactly one name and value');
  }
  const named = (flag) => argv[argv.indexOf(flag) + 1];
  const application = named('--provider-application');
  const appId = named('--app-id');
  const environmentName = named('--environment-name');
  const environmentValue = named('--environment-value');
  if (typeof application !== 'string' || !IDENTIFIER.test(application)) {
    throw new Error('provider application is invalid');
  }
  if (typeof appId !== 'string' || !IDENTIFIER.test(appId)) throw new Error('app_id is invalid');
  if (typeof environmentName !== 'string' || !ENVIRONMENT_NAME.test(environmentName)) {
    throw new Error('environment_name is invalid');
  }
  if (typeof environmentValue !== 'string' || environmentValue.includes('\0')) {
    throw new Error('environment_value is invalid');
  }
  return {
    provider_application: application,
    advance_command: [
      'env',
      `BITFIELD_MACHINE_WIDE_HOME=${MACHINE_WIDE_HOME}`,
      INSTALLED_APP_OPENER,
      '--same-app-id',
      appId,
      '--advance-log-owned-process-environment',
      `${environmentName}=${environmentValue}`,
    ].map(quotedShellToken).join(' '),
  };
}

/** A saved provider configuration describes how the application was LAST built,
 * and for a running application that is an already-built image. Deploying the
 * artifact's own Dockerfile beside that saved image is a contradiction the
 * provider refuses outright, so the build description is removed and the image
 * for this deployment comes from the artifact alone. Everything else the saved
 * configuration holds, services, mounts, checks and regions, is what keeps the
 * application the same application, so it is left exactly as it was found. */
export function configurationBuildingTheArtifactDockerfile(text, dockerfile) {
  const kept = [];
  let insideBuild = false;
  let insideSize = false;
  let replaced = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[{1,2}([^\]]+)\]{1,2}\s*$/.exec(line);
    if (header) {
      const name = header[1].trim();
      insideBuild = name === 'build' || name.startsWith('build.');
      // THE SAVED SIZE IS A MEASUREMENT OF THE PAST, and it was the one part of
      // the saved configuration that could take the application down.
      //
      // How big the machines are is named on the command line for this
      // deployment, read from the artifact. Leaving the saved size beside it
      // states the size twice, the older of the two wins, and the application
      // comes back smaller than it was. It cannot then finish opening its log,
      // so it prints that it is serving and is killed part way through, which
      // from outside is indistinguishable from a hang. That happened three
      // times in one night, and each recovery was undone by the next release,
      // because scaling a machine does not change what the application
      // DECLARES and every release returns to the declaration.
      //
      // Dropped for the same reason the build description above is dropped: a
      // saved answer to a question this deployment already answers is not
      // history worth keeping, it is a contradiction the provider resolves
      // against us.
      insideSize = name === 'vm' || name.startsWith('vm.');
      if (insideBuild && !replaced) {
        kept.push('[build]', `  dockerfile = "${dockerfile}"`);
        replaced = true;
      }
    }
    if (!insideBuild && !insideSize) kept.push(line);
  }
  if (!replaced) kept.push('[build]', `  dockerfile = "${dockerfile}"`, '');
  return kept.join('\n');
}

export function selectContainerArtifactDockerfileFromArgs(argv, contained = process.cwd()) {
  const flag = argv.indexOf('--select-container-artifact-dockerfile');
  if (flag === -1) return null;
  const named = argv[flag + 1];
  if (typeof named !== 'string' || !RELATIVE_PATH.test(named)) {
    throw new Error('--select-container-artifact-dockerfile requires one saved provider configuration the owner already wrote');
  }
  const canonical = realpathSync(contained);
  const file = resolve(canonical, named);
  if (!file.startsWith(`${canonical}${sep}`)) {
    throw new Error('provider configuration escapes its contained deployment');
  }
  const metadata = lstatSync(file);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('provider configuration must be one ordinary file');
  }
  const dockerfile = 'Dockerfile';
  writeFileSync(file, configurationBuildingTheArtifactDockerfile(readFileSync(file, 'utf8'), dockerfile));
  return { configuration: named, dockerfile };
}

export function currentContainerBaseApplicationFromArgs(argv) {
  if (!argv.includes('--read-current-container-base')) return null;
  const applicationFlag = argv.indexOf('--application');
  const application = argv[applicationFlag + 1];
  if (applicationFlag === -1 || typeof application !== 'string' || !IDENTIFIER.test(application)) {
    throw new Error('--application requires one semantic provider application');
  }
  return application;
}

export function deployedContainerApplicationFromArgs(argv) {
  if (!argv.includes('--read-deployed-container')) return null;
  const applicationFlag = argv.indexOf('--application');
  const application = argv[applicationFlag + 1];
  if (applicationFlag === -1 || typeof application !== 'string' || !IDENTIFIER.test(application)) {
    throw new Error('--application requires one semantic provider application');
  }
  return application;
}

export function retireProviderApplicationRequestFromArgs(argv) {
  if (!argv.includes('--retire-provider-application')) return null;
  const applicationFlag = argv.indexOf('--retire-provider-application');
  const application = argv[applicationFlag + 1];
  if (typeof application !== 'string' || !IDENTIFIER.test(application)) {
    throw new Error('--retire-provider-application requires one semantic provider application');
  }
  if (argv.length !== 2) {
    throw new Error('--retire-provider-application accepts only one semantic provider application');
  }
  return {
    kind: 'package-owned-deployment-request',
    profile: 'fly-retire-application',
    parameters: { application },
  };
}

export async function currentContainerBaseResult(application, options = {}) {
  const machines = currentServingFlyMachines(await flyMachines(
    application,
    options.credential ?? providerCredential(),
    options.fetchImplementation ?? fetch,
  ));
  const machine = machines[0];
  if (!machine || typeof machine.config?.image !== 'string') throw new Error('provider returned no current image');
  const shape = uniformCurrentFlyMachineShape(machines);
  return {
    kind: 'hosted-current-container-base-handle',
    owner_ref: 'hosted-public-app',
    provider_application: application,
    image: machine.config.image,
    release: machine.config?.metadata?.fly_release_version ?? null,
    machine: machine.id ?? null,
    ...shape,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const workspaceRoot = realpathSync(process.cwd());
  Promise.resolve()
    .then(async () => {
      if (argv[0] === '--invoke-hosted-product-operation') {
        if (argv.length !== 5 || argv[1] !== '--application' || argv[3] !== '--request-json') {
          throw new Error('expected --invoke-hosted-product-operation --application <name> --request-json <json>');
        }
        return invokeHostedProductLogOperation({
          application: argv[2],
          request: JSON.parse(argv[4]),
        });
      }
      if (argv[0] === '--apply-hosted-product-delta') {
        if (argv.length !== 5 || argv[1] !== '--application' || argv[3] !== '--machine') {
          throw new Error('expected --apply-hosted-product-delta --application <name> --machine <id>');
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of process.stdin) {
          length += chunk.length;
          if (length > 64 * 1024 * 1024) throw new Error('package delta request exceeds 64 MiB');
          chunks.push(chunk);
        }
        return applyHostedProductDelta({
          application: argv[2],
          machine: argv[4],
          request: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
      }
      const readBaseApplication = currentContainerBaseApplicationFromArgs(argv);
      if (readBaseApplication !== null) {
        return currentContainerBaseResult(readBaseApplication).then((result) => {
          writeFileSync(resolve(workspaceRoot, CURRENT_BASE_FILE_NAME), `${JSON.stringify(result)}\n`);
          return result;
        });
      }
      const deployedApplication = deployedContainerApplicationFromArgs(argv);
      if (deployedApplication !== null) {
        return nativeContainerDeploymentResult(deployedApplication).then((result) => {
          if (!result.boot_healthy) throw new Error('deployed native container did not publish a usable boot catalog');
          writeFileSync(resolve(workspaceRoot, NATIVE_RESULT_FILE_NAME), `${JSON.stringify(result)}\n`);
          return result;
        });
      }
      const nativeRequest = nativeContainerDeploymentRequestFromArgs(argv, workspaceRoot);
      if (nativeRequest !== null) return { prepared: true, provider_application: nativeRequest.application };
      const preparedFlag = argv.indexOf('--deploy-prepared-container-artifact');
      if (preparedFlag !== -1) {
        const application = argv[preparedFlag + 1];
        if (typeof application !== 'string' || !IDENTIFIER.test(application)) {
          throw new Error('--deploy-prepared-container-artifact requires one semantic provider application');
        }
        const siteRoot = resolve(workspaceRoot, 'site');
        if (realpathSync(dirname(siteRoot)) !== workspaceRoot || !existsSync(resolve(siteRoot, 'Dockerfile'))) {
          throw new Error('the prepared container artifact is unavailable');
        }
        const memberFileFlag = argv.indexOf('--member-readiness-file');
        const memberFile = memberFileFlag === -1 ? null : argv[memberFileFlag + 1];
        if (memberFile === null) throw new Error('a signed-in member trial is required before this container can be released');
        if (memberFile !== null && (typeof memberFile !== 'string' || !RELATIVE_PATH.test(memberFile))) {
          throw new Error('--member-readiness-file requires one contained relative file');
        }
        let releaseMemberReadiness = null;
        if (memberFile !== null) {
          const memberPath = resolve(workspaceRoot, memberFile);
          const memberMetadata = lstatSync(memberPath);
          if (memberMetadata.isSymbolicLink() || !memberMetadata.isFile()
              || dirname(realpathSync(memberPath)) !== workspaceRoot) {
            throw new Error('member readiness must be one ordinary direct child of the contained deployment workspace');
          }
          releaseMemberReadiness = JSON.parse(readFileSync(memberPath, 'utf8'));
          if (!releaseMemberReadiness || releaseMemberReadiness.application !== application) {
            throw new Error('the signed-in member trial does not belong to this application');
          }
        }
        return runProviderDeployment({
          descriptor: { kind: 'package-owned-deployment-request', profile: 'fly-built-image-trial',
            parameters: { application } },
          spawnChild: spawn,
          parentEnv: process.env,
          spawnOptionsBase: { stdio: ['ignore', 'pipe', 'pipe'], cwd: siteRoot },
          resultFile: resolve(workspaceRoot, RESULT_FILE_NAME),
          releaseMemberReadiness,
        });
      }
      const selection = selectContainerArtifactDockerfileFromArgs(argv);
      if (selection !== null) return { prepared: true, ...selection };
      const environmentCommands = installedAppProcessEnvironmentCommandsFromArgs(argv);
      if (environmentCommands !== null) {
        writeFileSync(
          resolve(workspaceRoot, 'installed-app-process-environment.json'),
          `${JSON.stringify(environmentCommands)}\n`,
        );
        return environmentCommands;
      }
      const retirementRequest = retireProviderApplicationRequestFromArgs(argv);
      if (retirementRequest !== null) {
        writeEphemeralFlyCredential(workspaceRoot);
        return { prepared: true, provider_application: retirementRequest.parameters.application };
      }
      const { descriptor, siteRoot } = deploymentRequestFromArgs(argv, workspaceRoot);
      return runProviderDeployment({
        descriptor,
        spawnChild: spawn,
        parentEnv: process.env,
        spawnOptionsBase: {
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(siteRoot === null ? {} : { cwd: siteRoot }),
        },
        resultFile: siteRoot === null ? null : resolve(workspaceRoot, RESULT_FILE_NAME),
      });
    })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
