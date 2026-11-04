// parts/receive-a-camera-stream/do-work/capabilities/this-network.mjs
//
// Purpose: the way-in capability for a camera on the same network as this computer: this computer's own address on
// that network. It opens nothing; the listener already takes streams on every network of this computer.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { localAddress } from '../../../receive-files-over-ftp/do-work/this-computers-address.mjs';

export const available = () => true;

export async function open({ ctx, port }) {
  const local = localAddress();
  if (!local) return { address: null, state: ctx.settings.words.no_way_in, close: async () => {} };
  return { address: `rtmp://${local}:${port}/${ctx.settings.listen.app}`, protocol: 'RTMP', state: ctx.fill(ctx.settings.words.network_on, { network: local }), close: async () => {} };
}
