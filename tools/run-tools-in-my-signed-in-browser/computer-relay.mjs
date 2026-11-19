// tools/run-tools-in-my-signed-in-browser/computer-relay.mjs
//
// PURPOSE
//   Keeps a browser extension reachable by the person's own computer. Whenever the person has allowed the computer (the
//   optional `nativeMessaging` permission), this holds one long-lived connection to the computer's native messaging host
//   (chrome.runtime.connectNative), asks the host to open its relay door (`relay_open`, browser-relay.mjs), answers each
//   request the host passes on with the function the extension gives (`run`), and sends the answer back over the same
//   connection. A tool run on the computer (ask-my-browser.mjs) reaches the browser this way, signed in as the person.
//   The extension starts it (`startComputerRelay`) with its own host name and its own answering function.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Without the person's permission nothing connects. A computer with no host placed, a host that refuses and a dropped
//      connection are retried on an alarm every `check_every_minutes` (browser-relay.json), never in a tight loop.
//   2. Only the connection this opened carries requests: a request is answered only from its own host's port, and answered
//      on that port with the `request_key` it came with.
//   3. Every request is answered, with the answer or `error`; `run` answers a request that names no tool in words.
import config from './browser-relay.json' with { type: 'json' };

const ALARM = 'computer-relay';
const PERMISSION = { permissions: ['nativeMessaging'] };

/** One relay to the computer: `connect()` holds the connection, `check()` mends it. */
export function makeComputerRelay({ browser = globalThis.chrome, host, run }) {
  let port = null;
  let opened = false;

  const ask = () => port?.postMessage({ action: 'relay_open' });

  async function connect() {
    if (port) return 'connected';
    if (!await browser.permissions.contains(PERMISSION)) return 'not_allowed';
    const own = browser.runtime.connectNative(host);
    port = own;
    opened = false;
    own.onMessage.addListener(message => {
      if (port !== own) return;
      if (message?.relay && typeof message.relay === 'object') {
        const { request_key, tool, input } = message.relay;
        run(String(tool ?? ''), input).then(answer => { if (port === own) own.postMessage({ relay_answer: { request_key, ...answer } }); });
      } else if (message?.action === 'relay_open') opened = message.ok === true;
    });
    own.onDisconnect.addListener(() => { void browser.runtime.lastError; if (port === own) { port = null; opened = false; } });
    ask();
    return 'connected';
  }

  /** On the alarm: connect when not connected, and ask again for the door when the host has not opened it. */
  async function check() {
    const held = port !== null;
    const state = await connect();
    if (held && !opened) ask();
    return state;
  }

  return { connect, check, get connected() { return port !== null; }, get opened() { return opened; } };
}

/** Starts the relay for an extension: `host` is its native messaging host's name, `run(tool, input)` answers { result } or { error }. */
export function startComputerRelay({ host, run, browser = globalThis.chrome }) {
  const relay = makeComputerRelay({ browser, host, run });
  const look = () => { relay.check().catch(() => {}); };
  browser.alarms.create(ALARM, { periodInMinutes: config.check_every_minutes });
  browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) look(); });
  browser.permissions.onAdded.addListener(look);
  browser.runtime.onStartup.addListener(look);
  look();
  return relay;
}
