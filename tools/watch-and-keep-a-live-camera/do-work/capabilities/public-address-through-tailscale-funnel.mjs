// parts/receive-a-camera-stream/do-work/capabilities/public-address-through-tailscale-funnel.mjs
//
// Purpose: the way-in capability that gives a camera one public address reaching this computer from any network
// (home Wi-Fi, a phone's hotspot, a hotel): Tailscale Funnel's TLS-terminated TCP on one of the public ports the
// tailnet allows (settings `tailscale.public_ports`), forwarded to the camera's port here. The camera sends RTMPS to
// rtmps://<this computer's Tailscale name>:<public port>/<app>; Tailscale's relays carry it, encrypted, to this computer.
//
// Non-Negotiable Invariants:
//   1. A public port already serving something else on this computer is never taken; the first free one is used, and
//      one already forwarding to this camera's port is kept, so the address a camera was given does not change.
//   2. The forward is checked every round and set again when missing (another program may rewrite Tailscale's serve
//      configuration), and closed when its row is turned off.
//   3. Funnel exposes the port to anyone; only a stream with the camera's own key is taken (take-a-stream.mjs).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { execFile } from 'node:child_process';
import { programIn } from '../take-a-stream.mjs';

const run = (program, args) => new Promise(resolve => execFile(program, args, { encoding: 'utf8', timeout: 20_000 }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr: String(stderr || error?.message || '').trim() })));
const tailscaleOf = settings => settings.tailscale.programs.map(name => programIn(settings.tailscale.search_path, name)).find(Boolean) ?? null;

/** Tailscale here: { program, name (this computer's public name), ports (the public ports Funnel allows) } or null with why. */
export async function funnelHere(settings, runImpl = run) {
  const program = tailscaleOf(settings);
  if (!program) return { why: 'Tailscale is not on this computer' };
  const status = await runImpl(program, ['status', '--json']);
  let self = null, state = null;
  try { const parsed = JSON.parse(status.stdout); self = parsed.Self; state = parsed.BackendState; } catch {}
  if (state !== 'Running' || !self?.DNSName) return { why: `Tailscale is ${state ? state.toLowerCase() : 'not answering'}` };
  const caps = Object.keys(self.CapMap ?? {});
  const allowed = caps.find(cap => cap.includes('funnel-ports'));
  const ports = allowed ? (/ports=([\d,]+)/.exec(allowed)?.[1] ?? '').split(',').map(Number) : [];
  if (!caps.includes('funnel') || !ports.length) return { why: 'Funnel is not allowed for this tailnet (Tailscale admin console, Access controls: add the funnel attribute)' };
  return { program, name: self.DNSName.replace(/\.$/, ''), ports };
}

export const available = async ({ settings }) => Boolean((await funnelHere(settings)).program);

/** The public port forwarding to `port` here, a free one to use, or null; from `tailscale funnel status --json`. */
export function portFor({ config, name, wanted, port }) {
  const tcp = config?.TCP ?? {};
  const forwardsHere = key => String(tcp[key]?.TCPForward ?? '').endsWith(`:${port}`);
  const used = key => Boolean(tcp[key]) || Object.keys(config?.Web ?? {}).includes(`${name}:${key}`);
  return wanted.find(key => forwardsHere(String(key))) ?? wanted.find(key => !used(String(key))) ?? null;
}

/** Open (or keep open) the public address for the camera taken on `port`. Answers { address, protocol, state, close() }. */
export async function open({ ctx, port, runImpl = run }) {
  const { settings } = ctx;
  const here = await funnelHere(settings, runImpl);
  if (!here.program) return { address: null, state: ctx.fill(settings.words.funnel_off, { why: here.why }), close: async () => {} };
  const status = await runImpl(here.program, ['funnel', 'status', '--json']);
  let config = {};
  try { config = JSON.parse(status.stdout || '{}'); } catch {}
  const wanted = settings.tailscale.public_ports.filter(key => here.ports.includes(key));
  const publicPort = portFor({ config, name: here.name, wanted, port });
  if (!publicPort) return { address: null, state: ctx.fill(settings.words.funnel_off, { why: `every public port (${wanted.join(', ')}) serves something else` }), close: async () => {} };
  const forwarding = String(config.TCP?.[publicPort]?.TCPForward ?? '').endsWith(`:${port}`);
  if (!forwarding || !config.AllowFunnel?.[`${here.name}:${publicPort}`]) {
    const set = await runImpl(here.program, ['funnel', '--bg', `--tls-terminated-tcp=${publicPort}`, `tcp://127.0.0.1:${port}`]);
    if (!set.ok) return { address: null, state: ctx.fill(settings.words.funnel_off, { why: set.stderr.split('\n')[0] }), close: async () => {} };
  }
  return {
    address: `rtmps://${here.name}:${publicPort}/${settings.listen.app}`,
    protocol: 'RTMPS',
    state: settings.words.funnel_on,
    close: async () => { await runImpl(here.program, ['funnel', `--tls-terminated-tcp=${publicPort}`, 'off']); },
  };
}
