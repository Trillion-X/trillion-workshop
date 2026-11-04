// tools/watch-and-keep-a-live-camera/do-work/plan-a-camera-listener.mjs
//
// The part of receiving a live camera stream that runs without a camera, FFmpeg or Tailscale: the addresses a camera
// is given and the listener that would take its stream. From one camera's `key` (its stream key) and `port` it
// answers the address FFmpeg listens on and the exact FFmpeg arguments the shared listener (take-a-stream.mjs
// takeAStream) starts FFmpeg with, captured from a stand-in that is never run, then the destination's own `output`
// arguments after the input. Given `funnel` (this computer's Tailscale name, the public ports its tailnet allows and
// what `tailscale funnel status --json` printed), it also picks the public RTMPS port the way the Funnel way in does
// (public-address-through-tailscale-funnel.mjs portFor: one already forwarding to this port, else a free one, never
// one serving something else) and answers the rtmps:// address with the trust anchor a camera imports for it
// (stream-settings.json camera_trust, the file RTMPcert.pem).
//
// Inputs: key (the camera's stream key, 8 to 128 letters, digits, - or _), port (1024-65535; stream-settings.json
// listen.first_port when left out), app (listen.app when left out), output (FFmpeg arguments after the input, [] when
// left out), funnel ({ name, ports, status }, optional).
// The key is shown as <key> in every answer, as the listener never writes it to a log line.
// Refuses a key or port of another shape, an output that is not a list of text, and a funnel without a name or ports.
// It starts no program, opens no port, changes no Funnel setting and sends nothing.
import { EventEmitter } from 'node:events';
import { listeningAddress, takeAStream } from './take-a-stream.mjs';
import { portFor } from './capabilities/public-address-through-tailscale-funnel.mjs';
import settings from '../stream-settings.json' with { type: 'json' };

const hidden = (text, key) => String(text).replaceAll(key, '<key>');

/** The arguments takeAStream gives FFmpeg, from a stand-in child that is stopped before anything happens. */
function listenerArguments({ port, app, key, output }) {
  let seen = null;
  const stream = () => Object.assign(new EventEmitter(), { setEncoding() {} });
  const spawnImpl = (program, args) => { seen = { program, args }; return Object.assign(new EventEmitter(), { stdout: stream(), stderr: stream(), kill() {} }); };
  takeAStream({ ffmpeg: settings.ffmpeg.program, port, app, key, output, spawnImpl }).stop();
  return seen;
}

export function planCameraListener({ key, port = settings.listen.first_port, app = settings.listen.app, output = [], funnel } = {}) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error('Give key: the camera\'s stream key, 8 to 128 letters, digits, - or _.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Give port: a whole number from 1024 to 65535 (the port this computer takes the stream on).');
  if (typeof app !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(app)) throw new Error('Give app: the word that ends the server address, letters, digits, - or _.');
  if (!Array.isArray(output) || output.some(word => typeof word !== 'string')) throw new Error('Give output: the destination\'s FFmpeg arguments after the input, as a list of text.');
  const ran = listenerArguments({ port, app, key, output });
  const answer = {
    listening_address: hidden(listeningAddress({ port, app, key }), key),
    camera_server_address: `rtmp://<this computer>:${port}/${app}`,
    ffmpeg: { program: ran.program, arguments: ran.args.map(word => hidden(word, key)) },
  };
  if (funnel === undefined) return answer;
  if (typeof funnel?.name !== 'string' || !funnel.name || !Array.isArray(funnel.ports) || !funnel.ports.every(Number.isInteger)) {
    throw new Error('Give funnel as { name: this computer\'s Tailscale name, ports: the public ports Funnel allows, status: what `tailscale funnel status --json` printed }.');
  }
  const name = funnel.name.replace(/\.$/, '');
  const wanted = settings.tailscale.public_ports.filter(each => funnel.ports.includes(each));
  const publicPort = portFor({ config: funnel.status ?? {}, name, wanted, port });
  const trust = settings.camera_trust.packages.filter(item => item.for_capability === 'public-address-through-tailscale-funnel')
    .map(({ id, file, subject, sha256, valid_until, use_when }) => ({ id, file, subject, sha256, valid_until, use_when }));
  return {
    ...answer,
    public: publicPort
      ? { port: publicPort, address: `rtmps://${name}:${publicPort}/${app}`, protocol: 'RTMPS', already_forwarding: String(funnel.status?.TCP?.[publicPort]?.TCPForward ?? '').endsWith(`:${port}`), trust }
      : { port: null, address: null, why: `every public port (${wanted.join(', ') || 'none allowed'}) serves something else` },
  };
}
