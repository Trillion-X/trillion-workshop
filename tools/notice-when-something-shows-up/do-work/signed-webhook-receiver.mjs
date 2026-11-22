#!/usr/bin/env node
// tools/notice-when-something-shows-up/do-work/signed-webhook-receiver.mjs
//
// Purpose
//   A resident service, run as a computer unit (not as a sandboxed tool run, which refuses inbound binds by design). It
//   listens on one host and port, answers only one path, checks each call with the signing rule its config names, and
//   tells each verified change to the local engine as a fact at its door's `wake:arrive`. A service that calls out
//   (a mail service, a payment service, a booking service) is one config file, never new code.
//
// Non-negotiable invariants
//   - It reuses the signed-call mechanism's checks (do-work/mechanisms/signed-service-calls.mjs: checkSignature,
//     changesOf, the signing rules) and the engine door's one operation (do-work/tell-the-engine.mjs: arriveOverDoor).
//     It keeps no copy of either.
//   - The path is checked before anything is read. A call on another path is answered 404 and read no further.
//   - The body is capped by config (body_byte_ceiling). Over the cap is answered 413 and nothing is verified or told.
//   - A call whose signature is not the one its config's rule declares is answered 401 and told to nobody.
//   - The secret is read from the unit's credential file (CREDENTIALS_DIRECTORY/<secret_credential>), used for the HMAC,
//     and never returned, logged or placed in a fact.
//   - The answer is sent only after every change in the call was accepted by the engine. A change the engine refused
//     is answered 503, so the service sends the call again. A change already told (same event key) is not sent twice.
//   - A call whose body the shape cannot read is answered 200 (the service must not resend it forever) and told as one
//     refused fact with place "unread", so the person sees that the shape needs widening.
//
// Config (DATA: one JSON file per service, given to the unit as its argument)
//   listen_host, listen_port   where it listens (127.0.0.1 behind the always-on's reverse proxy)
//   path                       the one path it answers, for example /webhooks/resend
//   secret_credential          the credential file name the unit is given, holding the signing secret
//   verify                     a signing rule name in signing-rules.json, or a verify object (as the mechanism reads)
//   shape                      where the change's place, change, key and time sit in the call (as the mechanism reads)
//   where                      the connection name the facts carry
//   kind                       the fact kind the engine's wake listens for
//   body_byte_ceiling?         the most body bytes accepted (default 1048576)
//   url?                       the public address the service signed the call at, when its rule needs it
//   door_file                  the JSON file holding the engine door {url, resource, capability} (run's own door shape)
//   subscribe?                 { mode, verify_credential }: answers the service's subscribe handshake, a GET whose hub.mode is
//                              mode and whose hub.verify_token is the credential's value, with hub.challenge as plain text.
//                              Any other GET on the path is refused with 403. Absent: every GET is answered 405.
//
// Usage
//   node signed-webhook-receiver.mjs <config.json>     (CREDENTIALS_DIRECTORY must be set by the unit)
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carried, changesOf, checkSignature, signingRuleNamed } from './mechanisms/signed-service-calls.mjs';
import { arriveOverDoor } from './tell-the-engine.mjs';

export const DEFAULT_BODY_CEILING = 1048576;
/** How many event keys this process remembers as told, so a service's repeat is not sent to the engine twice. */
const TOLD_LIMIT = 10000;
const NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** The config as the receiver reads it, or a thrown refusal naming the one field that is wrong. */
export function receiverConfigOf(raw) {
  const refuse = (reason) => { throw Object.assign(new Error(`receiver config refused: ${reason}`), { reason }); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('not-an-object');
  if (typeof raw.listen_host !== 'string' || !raw.listen_host) refuse('bad-listen-host');
  if (!Number.isInteger(raw.listen_port) || raw.listen_port < 0 || raw.listen_port > 65535) refuse('bad-listen-port');
  if (typeof raw.path !== 'string' || !raw.path.startsWith('/')) refuse('bad-path');
  if (typeof raw.secret_credential !== 'string' || !NAME.test(raw.secret_credential)) refuse('bad-secret-credential');
  const verify = typeof raw.verify === 'string' ? signingRuleNamed(raw.verify) : raw.verify;
  if (!verify || typeof verify !== 'object') refuse('unknown-verify-rule');
  if (!raw.shape || typeof raw.shape !== 'object') refuse('no-shape');
  if (typeof raw.where !== 'string' || !raw.where) refuse('no-where');
  if (typeof raw.kind !== 'string' || !raw.kind) refuse('no-fact-kind');
  const ceiling = raw.body_byte_ceiling ?? DEFAULT_BODY_CEILING;
  if (!Number.isInteger(ceiling) || ceiling <= 0) refuse('bad-body-ceiling');
  const subscribe = raw.subscribe ?? null;
  if (subscribe !== null && (typeof subscribe !== 'object' || typeof subscribe.mode !== 'string' || !subscribe.mode || typeof subscribe.verify_credential !== 'string' || !NAME.test(subscribe.verify_credential))) refuse('bad-subscribe');
  return {
    listen_host: raw.listen_host,
    listen_port: raw.listen_port,
    path: raw.path,
    secret_credential: raw.secret_credential,
    verify,
    shape: raw.shape,
    where: raw.where,
    kind: raw.kind,
    body_byte_ceiling: ceiling,
    url: typeof raw.url === 'string' && raw.url ? raw.url : null,
    subscribe: subscribe === null ? null : { mode: subscribe.mode, verify_credential: subscribe.verify_credential },
  };
}

/** The changes one verified call says happened, as the fact's payload fields (text, nulls left out). */
function factOfChange(kind, change) {
  const payload = {};
  for (const [name, value] of Object.entries(change.detail)) if (value !== null && value !== undefined) payload[name] = String(value);
  return { kind, event_id: change.event_key, payload };
}

/**
 * The HTTP server for one service. It is not listening yet: the caller listens on the config's host and port.
 * @param {{config: object, secret: string, arrive: (fact: object) => Promise<unknown>, now?: () => number}} args
 *   `arrive` tells one fact to the engine and rejects when the engine does not take it.
 */
export function createReceiver({ config, secret, arrive, now = () => Date.now(), subscribe = null }) {
  const told = new Set();
  const remember = (eventId) => {
    told.add(eventId);
    if (told.size > TOLD_LIMIT) told.delete(told.values().next().value);
  };
  const answer = (response, status, value, extra = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...extra });
    response.end(JSON.stringify(value));
  };
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://receiver.invalid');
    if (url.pathname !== config.path) return answer(response, 404, { recorded: false, reason: 'no-such-path' });
    if (request.method === 'GET' && subscribe) {
      const challenge = url.searchParams.get('hub.challenge');
      const offered = Buffer.from(url.searchParams.get('hub.verify_token') ?? '');
      const expected = Buffer.from(subscribe.token);
      const matches = url.searchParams.get('hub.mode') === subscribe.mode && offered.length === expected.length && timingSafeEqual(offered, expected);
      if (!matches || challenge === null) return answer(response, 403, { recorded: false, reason: 'subscribe-refused' });
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      return response.end(challenge);
    }
    if (request.method !== 'POST') return answer(response, 405, { recorded: false, reason: 'method-not-allowed' }, { Allow: 'POST' });
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.body_byte_ceiling) {
      request.resume();
      return answer(response, 413, { recorded: false, reason: 'body-over-ceiling' }, { Connection: 'close' });
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of request) {
      received += chunk.length;
      if (received > config.body_byte_ceiling) return answer(response, 413, { recorded: false, reason: 'body-over-ceiling' }, { Connection: 'close' });
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const nowSeconds = Math.floor(now() / 1000);
    const checked = checkSignature({ verify: config.verify, headers: request.headers, body, secret, nowSeconds, url: config.url });
    if (!checked.ok) return answer(response, 401, { recorded: false, reason: checked.reason });
    const read = changesOf({ shape: config.shape, where: config.where, body, receivedAt: new Date(nowSeconds * 1000) });
    // A verified call the shape cannot read is still the service's: answered 200 so it is not sent forever, and told as one
    // refused fact so the person sees the row needs widening (the mechanism's own rule).
    const changes = read.refused
      ? [{ event_key: `${config.where}:refused:${nowSeconds}:${received}`, detail: { where: config.where, place: 'unread', change: 'changed', at: new Date(nowSeconds * 1000).toISOString(), key: read.refused, before: null, after: carried(body) } }]
      : read.changes;
    let duplicates = 0;
    try {
      for (const change of changes) {
        const fact = factOfChange(config.kind, change);
        if (told.has(fact.event_id)) { duplicates += 1; continue; }
        await arrive(fact);
        remember(fact.event_id);
      }
    } catch (error) {
      return answer(response, 503, { recorded: false, reason: String(error?.message ?? error) });
    }
    return answer(response, 200, { recorded: true, changes: changes.length, duplicates });
  });
}

/**
 * The unit's start: reads the config, the credential and the door, listens, and tells each fact through the door.
 * @param {{configPath: string, env?: object, fetchImpl?: Function, say?: (line: string) => void}} args
 * @returns {Promise<import('node:http').Server>} the listening server
 */
export async function startReceiver({ configPath, env = process.env, fetchImpl = fetch, say = (line) => console.error(line) }) {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  const config = receiverConfigOf(raw);
  if (!env.CREDENTIALS_DIRECTORY) throw new Error('CREDENTIALS_DIRECTORY is not set: the unit must be given the signing secret as a credential.');
  const secret = readFileSync(path.join(env.CREDENTIALS_DIRECTORY, config.secret_credential), 'utf8').replace(/\r?\n$/, '');
  if (!secret) throw new Error(`the credential ${config.secret_credential} is empty`);
  const subscribe = config.subscribe ? { mode: config.subscribe.mode, token: readFileSync(path.join(env.CREDENTIALS_DIRECTORY, config.subscribe.verify_credential), 'utf8').replace(/\r?\n$/, '') } : null;
  if (subscribe && !subscribe.token) throw new Error(`the credential ${config.subscribe.verify_credential} is empty`);
  const door = JSON.parse(readFileSync(raw.door_file, 'utf8'));
  if (typeof door.url !== 'string' || typeof door.capability !== 'string') throw new Error('the door file must hold a url and a capability');
  const arrive = async (fact) => {
    try {
      await arriveOverDoor(door, fact, { fetchImpl });
      say(JSON.stringify({ told: fact.kind, event_id: fact.event_id }));
    } catch (error) {
      say(JSON.stringify({ refused: fact.kind, event_id: fact.event_id, why: error.message }));
      throw error;
    }
  };
  const server = createReceiver({ config, secret, arrive, subscribe });
  await new Promise((resolve) => server.listen(config.listen_port, config.listen_host, resolve));
  say(JSON.stringify({ listening: `${config.listen_host}:${server.address().port}`, path: config.path }));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('usage: signed-webhook-receiver.mjs <config.json>');
    process.exit(2);
  }
  startReceiver({ configPath }).then((server) => {
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }, (error) => {
    console.error(error.message);
    process.exit(1);
  });
}
