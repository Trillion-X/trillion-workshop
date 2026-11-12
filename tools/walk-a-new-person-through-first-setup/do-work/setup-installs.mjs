// src/setup-installs.mjs
//
// The installs every Trillion setup makes, filled with this service's address: the Trillion apps for the person's
// devices (src/devices.json through src/devices.mjs: the iPhone app, the Send to Trillion extension and the app for
// their computer, each with its public link or its honest not-yet words), plus the executable local harness setup.
// Its manifest owns the published pair, supported hosts and hook inventory. This is a setup plan, not evidence that
// a person's computer has run it. The current AI executes the plan and reads the installer's checked report.
import harness from '../../keep-and-wake-ai-sessions-on-this-computer/harness/setup.json' with { type: 'json' };
import { devicesStep } from '../../set-up-my-devices-and-cameras/src/devices.mjs';
import placements from '../../pick-where-one-piece-of-work-runs-the-device/records/workshop-placement-records.json' with { type: 'json' };
import { agentForTool } from '../../hand-off-jobs-between-agents/src/agent-tool-runs.mjs';
import { formerAgentIds } from '../../shared-code/src/renamed-tools.mjs';

export const nativeHarnessPlacement = placements.records.find(row => row.payload.settings?.computer_scope)?.payload;
export const nativeHarnessTool = nativeHarnessPlacement.settings.computer_scope.tool_ids[0];

/** Account-owned observations advertise an execution route; only the returned inspect report proves local state. */
export function nativeHarnessSetup(observations, now = Date.now()) {
  const selected = observations?.computers;
  const discovery = { tool: 'read_setup', arguments: {} };
  if (!Array.isArray(selected)) return { status: 'unknown', reason: 'The current account computer inventory has not been read.', next_call: discovery, computers: [] };
  const computers = selected.map(computer => {
    const id = computer.computer_id;
    const agent_id = `${nativeHarnessPlacement.settings.computer_scope.agent_prefix}${id}`;
    const ids = [agent_id, ...formerAgentIds(agent_id)];
    const observed = ids.map(known => observations.cards?.[known]).find(Boolean);
    const card = observed?.agents?.find(row => ids.includes(row.agent_id));
    let status = 'unavailable', reason = 'This computer has not advertised the installed setup tool. Its normal signed Mac app must be updated and connected before this route is available.';
    if (!Number.isFinite(Date.parse(computer.reported_at)) || !Array.isArray(observed?.agents)) { status = 'unknown'; reason = 'The exact computer record or its tool card could not be read.'; }
    else {
      try {
        agentForTool({ agents: { cardOf: () => card }, settings: nativeHarnessPlacement.settings, tool_id: nativeHarnessTool, input: { computer_id: id }, now });
        status = 'advertised'; reason = 'This exact Mac advertises the tool with current capacity. Dispatch and the native adapter recheck the target; no local inspection has run yet.';
      } catch { /* unavailable is distinct from configuration or execution evidence */ }
    }
    const hosts = status === 'advertised' ? harness.hosts.map(host => ({ id: host.id, name: host.name,
      inspect: { tool: 'run_tool', arguments: { tool_id: nativeHarnessTool, input: { computer_id: id, harness: host.id, action: 'inspect' } } } })) : [];
    return { computer_id: id, scope_id: `${nativeHarnessPlacement.settings.computer_scope.skill_prefix}${id}`, agent_id, status, reason,
      reported_at: computer.reported_at ?? null, hosts };
  });
  return { tool_id: nativeHarnessTool, status: computers.some(row => row.status === 'advertised') ? 'advertised' : computers.some(row => row.status === 'unknown') ? 'unknown' : 'unavailable',
    computers, ...(observations.truncated ? { truncated: true, reason: 'Only the first 32 owned computers were inspected.' } : {}),
    instructions: 'Choose only an observed or explicitly selected harness on the exact computer. Run inspect first, then authorized apply or remove through the same tool. Codex trust additionally requires trust_hooks:true and every exact configuration.evidence.hooks definition_hash from the reviewed current inspect report as reviewed_definition_hashes; changed definitions are refused before any write. After apply, run inspect again. Keep report.scope and report.action unchanged when retaining evidence. Advertisement, apply and remove are not setup completion.' };
}

const quote = text => `'${String(text).replace(/'/g, `'\\''`)}'`;

export function harnessSetup(origin, observations) {
  const base = new URL(origin);
  if (base.protocol !== harness.publication.served_over || base.username || base.password) throw new Error('Harness setup downloads require the service HTTPS origin.');
  const files = harness.publication.files.map(name => ({ name, url: new URL(`${harness.publication.path}/${name}`, base).href }));
  const atHome = name => `"$HOME"/${quote([harness.state_folder, name].filter(Boolean).join('/'))}`;
  const folder = atHome();
  const installer = atHome('setup.mjs');
  const runtime = quote(`${harness.mac_app.path}/${harness.mac_app.runtime}`);
  const download = ['set -eu', `mkdir -p ${folder}`, ...files.map(file => `curl -fsSL --proto '=https' ${quote(file.url)} -o ${atHome(`${file.name}.part`)}`), ...files.map(file => `mv ${atHome(`${file.name}.part`)} ${atHome(file.name)}`)].join('\n');
  const hosts = harness.hosts.map(host => ({
    id: host.id, name: host.name,
    commands: Object.fromEntries(['inspect', 'apply', 'remove'].map(action => [action, `${runtime} ${installer} --action ${action} --harness ${quote(host.id)}`])),
    ...(host.trust ? { trust_after_review: `${runtime} ${installer} --action apply --harness ${quote(host.id)} --trust-hooks` } : {}),
    hook_review: host.hook_review,
  }));
  const instructions = [
    'Read native first. When the exact owned computer advertises the native tool, use its selected host inspect call directly, then perform authorized apply and inspect again through that tool. A cloud-only AI does not need its own terminal for this route. If the installed Mac has not advertised it, keep that availability gap explicit; publishing web code does not update the signed Mac app.',
    'Run the local setup for the current or explicitly chosen supported harness yourself when this session can operate that Mac. Keep a cloud-only harness in its supported account setup; never select a different AI to make a check pass.',
    'After installing the published Trillion Mac app, download the setup files to the stable folder with download_command. Run that chosen host\'s apply command, then inspect. Applying again repairs or updates the owned hook definitions without duplicating them or replacing other settings.',
    'Read the JSON checks individually. Exit 0 means the reported local checks are ready; exit 2 means work remains; exit 1 is an installer error. A configured hook is not an observed execution, and an observed process is not proof that a message arrived or work completed in the account.',
    'Only after reviewing the exact new Codex hook definitions and having authority to trust them may you use trust_after_review. An explicitly disabled hook or a managed policy stays unchanged.',
    'The Mac app already owns the helper, transcript sweeps, interrupted-work recovery and recurring work handler. Do not add a second helper, LaunchAgent or polling schedule. The installer inspects the existing account key and AI choice without changing that choice, launching a model, or importing personal files.',
    'Finish the account-owned connection, source-health, automation and round-trip checks after local setup. Open the native permission request when required and leave only the protected consent to the person. Never mark a notification permission, iPhone installation or widget placement complete from these local checks.',
    'Removal works even after the payload is missing: run the kept setup.mjs with an available Node runtime and --action remove --harness <the same id>. It removes its exact hook definitions while preserving other host settings; backups beside the host config preserve earlier bytes for recovery.',
  ];
  // MCP entries in other AIs' configs are the person's own explicit action (harness/mcp-registration.mjs): preview first,
  // then register the locally supported apps they named; unregister takes the entry out. Hook apply never writes one.
  const localMcpClients = harness.mcp_registration.clients.filter(row => row.transport === 'local-stdio').map(row => row.id);
  const mcpCommand = action => `${runtime} ${installer} --action ${action} --client ${quote(localMcpClients.join(','))}`;
  const mcp_registration = { clients: harness.mcp_registration.clients.map(({ id, sign_in }) => ({ id, sign_in })),
    commands: Object.fromEntries(['inspect', 'preview', 'register', 'unregister'].map(action => [action, mcpCommand(`mcp-${action}`)])),
    instructions: 'Claude Code and Codex use the installed Mac app local bridge. Only when the person asks for it: run preview for the apps they named (narrow --client to those), show them the exact diff, then run register with --reviewed <the preview review_hash>. An entry under the same name that points elsewhere is theirs and is left. A registered entry still needs each app\'s sign_in and a real round trip before it is a connection. Other clients keep their row\'s configured transport.' };
  const steps = `${instructions.join('\n')}\nDownload command:\n${download}\nSelected-host commands:\n${hosts.map(host => `${host.name}:\n${host.commands.apply}\n${host.commands.inspect}`).join('\n')}`;
  return { schema: harness.schema, status: 'not_inspected', native: nativeHarnessSetup(observations), files, download_command: download, hosts, hooks: harness.hooks.map(({ id, event, script }) => ({ id, event, script })), mcp_registration, instructions, steps, boundaries: harness.boundaries };
}

export function setupInstalls(origin, observations) {
  // Harness files are served only over the service's HTTPS origin; any other origin (a local run) offers none and says
  // so, and the rest of setup still reads.
  const harness_setup = new URL(origin).protocol === harness.publication.served_over ? harnessSetup(origin, observations)
    : { schema: harness.schema, status: 'not_served', steps: harness.publication.not_served.replace('{origin}', origin) };
  // Keep the existing prompt placeholder working, but give every caller the same complete installer instead of
  // the older two-hook manual. Nothing here claims the account's local setup has already been applied.
  return { origin, devices_step: devicesStep(), harness_setup };
}

