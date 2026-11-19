/**
 * notice-when-something-shows-up/do-work/mechanisms/signed-service-calls.mjs
 *
 * Purpose
 *   One waiting mechanism: wait for a service to call over HTTPS, check that the
 *   service really sent the call, and report each thing the call says changed. A
 *   payment service, a mail service, a booking service and a service that watches
 *   many apps for the person are all this one leaf with different DATA: how the
 *   service signs (`verify`) and where its call keeps what changed (`shape`).
 *
 * Non-negotiable invariants
 *   - It names no service. How a call is signed is the waiter row's `verify`
 *     (header parts, the signed text, the hash, the encoding, the replay window),
 *     and where a change sits in the call is its `shape` (paths into the body).
 *     A new service is a new row, never an edit here.
 *   - A call that is not signed as the row declares is answered 401 and told to
 *     nobody. Nothing in an unverified body is read, kept or reported.
 *   - The secret is read from a descriptor (`secret_fd`), used for one HMAC per
 *     call, and never returned, logged or placed in a reason.
 *   - The answer is sent only after every change in the call was written down;
 *     a change that could not be written is answered 503, so the service sends
 *     the call again (each change's event key makes the repeat one fact).
 *   - A change carries itself: before and after as JSON text when each fits a
 *     fact field (CARRIED_BYTES), else null; `key` is the service's own id, so a
 *     woken run that needs more reads it from the service by key.
 *
 * The fact fields, one set for every way a change is told
 *   where   the connection the call came through (the waiter row's `where`)
 *   place   the service's kind of thing that changed (invoice, message, booking)
 *   change  added | changed | removed
 *   at      when it changed, as ISO time
 *   key     the service's own id for the thing
 *   before, after   JSON text, or null when larger than a fact field holds
 *
 * Settings (mechanism_settings)
 *   listen_host, listen_port, body_byte_ceiling   as inbound-http-delivery
 *   where       the connection's name (no secret)
 *   secret_fd   the descriptor holding the signing secret (default 4; a waiter that names its own credential_name reads it from the descriptor the run gave it instead)
 *   verify      { parts: { <name>: { header, match? } }, signed: "<text with {name} and {body}>",
 *                 signature: "<part name>", hash: "sha256", encoding: "hex" | "base64",
 *                 secret_prefix?: "<prefix the secret starts with>", secret_encoding?: "utf8" | "base64",
 *                 timestamp?: "<part name holding seconds>", tolerance_seconds?: 300 }
 *               A part's `match` is a regular expression; every capture of its first group is a candidate
 *               (a service rotating its secret sends several signatures).
 *   shape       { changes?: "<path to a list of changes, else the body is one change>",
 *                 place: "<path>" | { value } | { path, map, otherwise? }, change: { path, map: { <value>: "added"|"changed"|"removed" }, otherwise? },
 *                 key: "<path>" | ["<path>", ...], at: "<path>", at_unit?: "seconds" | "ms" | "iso",
 *                 before?: "<path>", after?: "<path>" }
 *               A path is dot-separated (`data.object.id`); a list of paths takes the first one present.
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const MECHANISM_REF = "package::notice-when-something-shows-up::mechanism::signed-service-calls";
// A told fact holds at most 1,024 bytes a field (the engine's fact inbox, trillion-rust src/wake/host-events.json).
export const CARRIED_BYTES = 1000;
const CHANGES = new Set(["added", "changed", "removed"]);

export const carried = (value) => {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(text) <= CARRIED_BYTES ? text : null;
};

export function describeMechanism() {
  return {
    mechanism_ref: MECHANISM_REF,
    detail_fields: ["where", "place", "change", "at", "key", "before", "after"],
    conditions: ["became-reachable"],
  };
}

export function readSettings(settings = {}) {
  const port = Number(settings.listen_port);
  const ceiling = Number(settings.body_byte_ceiling);
  const fd = Number(settings.secret_fd);
  return {
    listen_host: typeof settings.listen_host === "string" && settings.listen_host.trim() ? settings.listen_host.trim() : "127.0.0.1",
    listen_port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 0,
    body_byte_ceiling: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 1048576,
    where: typeof settings.where === "string" ? settings.where : "",
    secret_fd: Number.isInteger(fd) && fd >= 0 ? fd : 4,
    verify: settings.verify ?? null,
    shape: settings.shape ?? null,
  };
}

/** The value at a dot path, or the first present of several paths. */
export function at(value, path) {
  if (Array.isArray(path)) {
    for (const one of path) { const found = at(value, one); if (found !== undefined && found !== null) return found; }
    return undefined;
  }
  if (typeof path !== "string" || path === "") return value;
  return path.split(".").reduce((current, step) => (current === null || current === undefined ? undefined : current[step]), value);
}

const header = (headers, name) => {
  const value = headers?.[String(name).toLowerCase()];
  return Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : "";
};

/** Each part's candidates: the header's whole value, or every capture of `match`'s first group. */
function partsOf(verify, headers) {
  const parts = {};
  for (const [name, spec] of Object.entries(verify.parts ?? {})) {
    const text = header(headers, spec.header);
    if (!spec.match) { parts[name] = text ? [text] : []; continue; }
    const pattern = new RegExp(spec.match, "g");
    parts[name] = [...text.matchAll(pattern)].map((found) => found[1]).filter(Boolean);
  }
  return parts;
}

function secretBytes(secret, verify) {
  let text = secret;
  if (verify.secret_prefix && text.startsWith(verify.secret_prefix)) text = text.slice(verify.secret_prefix.length);
  return verify.secret_encoding === "base64" ? Buffer.from(text, "base64") : Buffer.from(text, "utf8");
}

/**
 * Check one call against the row's `verify`. Answers {ok:true} or {ok:false, reason}; never says why beyond a code.
 * @param {{verify:object, headers:object, body:string, secret:string, nowSeconds?:number}} args
 */
export function checkSignature({ verify, headers, body, secret, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!verify || typeof verify !== "object") return { ok: false, reason: "no-verify-row" };
  if (typeof secret !== "string" || !secret) return { ok: false, reason: "no-signing-secret" };
  if (!["sha256", "sha512", "sha1"].includes(verify.hash ?? "sha256")) return { ok: false, reason: "unknown-hash" };
  if (!["hex", "base64"].includes(verify.encoding ?? "hex")) return { ok: false, reason: "unknown-encoding" };
  const parts = partsOf(verify, headers);
  const candidates = parts[verify.signature] ?? [];
  if (candidates.length === 0) return { ok: false, reason: "no-signature" };
  let missing = false;
  const signed = String(verify.signed ?? "{body}").replace(/\{([a-z_]+)\}/g, (_, name) => {
    if (name === "body") return body;
    const value = parts[name]?.[0];
    if (value === undefined) missing = true;
    return value ?? "";
  });
  if (missing) return { ok: false, reason: "missing-signed-part" };
  if (verify.timestamp) {
    const sent = Number(parts[verify.timestamp]?.[0]);
    const window = Number.isFinite(Number(verify.tolerance_seconds)) ? Number(verify.tolerance_seconds) : 300;
    if (!Number.isFinite(sent)) return { ok: false, reason: "no-timestamp" };
    if (window > 0 && Math.abs(nowSeconds - sent) > window) return { ok: false, reason: "outside-replay-window" };
  }
  const expected = createHmac(verify.hash ?? "sha256", secretBytes(secret, verify)).update(signed, "utf8").digest();
  const matched = candidates.some((candidate) => {
    let given;
    try { given = Buffer.from(candidate.replace(/^0x/i, ""), verify.encoding ?? "hex"); } catch { return false; }
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matched ? { ok: true } : { ok: false, reason: "signature-mismatch" };
}

function isoOf(value, unit) {
  if (value === undefined || value === null || value === "") return null;
  if (unit === "iso") { const time = new Date(value); return Number.isNaN(time.getTime()) ? null : time.toISOString(); }
  const number = Number(value);
  if (!Number.isFinite(number)) { const time = new Date(value); return Number.isNaN(time.getTime()) ? null : time.toISOString(); }
  return new Date(unit === "ms" ? number : number * 1000).toISOString();
}

/** The kind of thing that changed: a fixed value, a path, or a path whose value a map turns into the kind. */
function placeOf(spec, item) {
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    if ("value" in spec) return spec.value;
    const raw = at(item, spec.path);
    return spec.map?.[raw] ?? spec.otherwise ?? raw;
  }
  return at(item, spec);
}

/**
 * The changes one verified call says happened, as fact fields, by the row's `shape`.
 * @returns {{changes:Array<{event_key:string, detail:object}>}|{refused:string}}
 */
export function changesOf({ shape, where, body, receivedAt = new Date() }) {
  if (!shape || typeof shape !== "object") return { refused: "no-shape-row" };
  let parsed;
  try { parsed = JSON.parse(body); } catch { return { refused: "body-is-not-json" }; }
  const list = shape.changes ? at(parsed, shape.changes) : [parsed];
  if (!Array.isArray(list)) return { refused: "no-changes-at-path" };
  const changes = [];
  for (const item of list) {
    const place = placeOf(shape.place, item);
    const raw = shape.change?.path ? at(item, shape.change.path) : undefined;
    const change = shape.change?.map?.[raw] ?? shape.change?.otherwise ?? null;
    const key = at(item, shape.key);
    if (place === undefined || key === undefined || !CHANGES.has(change)) return { refused: "change-not-in-shape" };
    const when = isoOf(at(item, shape.at), shape.at_unit) ?? receivedAt.toISOString();
    const detail = {
      where, place: String(place), change, at: when, key: String(key),
      before: shape.before ? carried(at(item, shape.before)) : null,
      after: carried(shape.after ? at(item, shape.after) : item),
    };
    changes.push({ event_key: `${where}:${detail.place}:${detail.key}:${detail.change}:${detail.at}`, detail });
  }
  return { changes };
}

/**
 * Wait for signed calls and report each change once.
 * @param {object} settings the descriptor row's mechanism_settings
 * @param {object} handlers onTransition, signal, and for tests: secret, makeServer, now
 */
export async function watchForTransitions(settings, handlers) {
  const own = readSettings(settings);
  const signal = handlers.signal;
  const secret = handlers.secret ?? readFileSync(handlers.credentialFd ?? own.secret_fd, "utf8").trim();
  const answer = (response, status, value) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  const server = (handlers.makeServer ?? createServer)(async (request, response) => {
    const chunks = [];
    let received = 0;
    for await (const chunk of request) {
      received += chunk.length;
      if (received > own.body_byte_ceiling) return answer(response, 413, { recorded: false, reason: "body-over-ceiling" });
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const nowSeconds = Math.floor((handlers.now?.() ?? Date.now()) / 1000);
    const checked = checkSignature({ verify: own.verify, headers: request.headers, body, secret, nowSeconds });
    if (!checked.ok) return answer(response, 401, { recorded: false, reason: checked.reason });
    const read = changesOf({ shape: own.shape, where: own.where, body, receivedAt: new Date(nowSeconds * 1000) });
    // A verified call whose changes this row's shape cannot read is still the service's: answered 200 so it is not
    // sent forever, and reported as one refused-shape fact so the person sees the row needs widening.
    const changes = read.refused
      ? [{ event_key: `${own.where}:refused:${nowSeconds}:${received}`, detail: { where: own.where, place: "unread", change: "changed", at: new Date(nowSeconds * 1000).toISOString(), key: read.refused, before: null, after: carried(body) } }]
      : read.changes;
    try {
      for (const one of changes) {
        const told = await handlers.onTransition({ condition: "became-reachable", observed_identity: { where: own.where, place: one.detail.place }, event_key: one.event_key, detail: one.detail });
        if (told === false) throw new Error("the engine did not take the fact");
      }
    } catch (error) {
      return answer(response, 503, { recorded: false, reason: String(error?.message ?? error) });
    }
    return answer(response, 200, { recorded: true, changes: changes.length });
  });
  await new Promise((resolve) => server.listen(own.listen_port, own.listen_host, resolve));
  handlers.listening?.(server.address());
  await new Promise((resolve) => {
    const stop = () => { try { server.close(() => resolve()); } catch { resolve(); } };
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
  });
}
