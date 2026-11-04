// parts/receive-a-camera-stream/do-work/capabilities/router-port-forward.mjs
//
// Purpose: the way-in capability for a home router that forwards the camera's port to this computer: the home
// network's public address. It opens nothing on this computer and cannot set the router; its row says which port the
// router must forward to which local address.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { localAddress } from '../../../receive-files-over-ftp/do-work/this-computers-address.mjs';

export const available = () => true;

/** The home network's public IPv4 address, as the address in `ctx.settings.public_address_from` sees it, or null. */
async function publicAddress(ctx) {
  const from = ctx.settings.public_address_from;
  if (!from) return null;
  try { const response = await fetch(from, { signal: AbortSignal.timeout(10_000) }); const text = (await response.text()).trim(); return /^\d+\.\d+\.\d+\.\d+$/.test(text) ? text : null; } catch { return null; }
}

export async function open({ ctx, port }) {
  const outside = await publicAddress(ctx);
  return {
    address: outside ? `rtmp://${outside}:${port}/${ctx.settings.listen.app}` : null,
    protocol: 'RTMP',
    state: ctx.fill(ctx.settings.words.router_check, { port, local: localAddress() ?? 'no network' }),
    close: async () => {},
  };
}
