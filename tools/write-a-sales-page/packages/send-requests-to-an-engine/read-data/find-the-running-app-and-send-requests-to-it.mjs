// Find one running Bitfield app from its owner's status file, then send Envelope
// target requests to that app. This is plain-process transport only: it owns no
// product data, no workflow semantics, and no app identity.
//
// A LOCAL app has no network address. Its owner publishes the Unix-domain socket
// the shell serves over, and this module dials that path. A REMOTE engine is
// reached by the name a caller was handed (`url`), which is the only address that
// is genuinely DATA. Nothing here reads a port out of a file, because no port is
// written into one.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 1800000;
const BASIS_HEADER = "X-Bitfield-Running-Command-List-Basis";
// Transport handles are private runtime state, never serializable package DATA.
const localSelectors = new WeakMap();
const sessionTransports = new WeakMap();
// Authentication belongs to the live transport session, never to package DATA or
// the serializable session object. Hosted private apps can therefore carry the
// browser/session header that admitted the caller without persisting that secret.
const sessionRequestHeaders = new WeakMap();
/** Path base for socket sessions. The host is never resolved and never dialled; the socket path
 *  is the transport and this string only lets request paths compose the way they do for a URL. */
export const SOCKET_SESSION_PATH_BASE = "http://bitfield-shell";

export class RunningAppRequestError extends Error {
  constructor(message, { status, body, target } = {}) {
    super(message);
    this.name = "RunningAppRequestError";
    this.status = status;
    this.body = body;
    this.target = target;
  }
}

/** The app-open owner's status file for one app id, the machine's own layout. */
export function statusFileForAppId(appId, { home = os.homedir() } = {}) {
  const id = nonEmpty(appId);
  if (!id) throw new Error("A running-app id is required");
  if (id.includes("/") || id.includes("..")) throw new Error(`Invalid running-app id: ${id}`);
  return path.join(
    home,
    ".bitfield/runtime-kit/app-log-storage-folders",
    `app-log-storage-for-bitfield-app-${Buffer.from(id, "utf8").toString("hex")}`,
    "runtime-kit/running-now/open-this-bitfield-app/runtime-app-authority-status.json",
  );
}

/** Read the transport one running app publishes: `{ socketPath }` for a local app, `{ url }`
 *  for a deployment that declared a TCP listen address. The status file is a claim about the
 *  past; only a `/boot` answer over the transport is evidence about the present. */
export function findRunningAppTransport({ statusFile, appId, readFile = fs.readFileSync } = {}) {
  const selectedStatusFile = nonEmpty(statusFile) ?? (
    nonEmpty(appId) ? statusFileForAppId(appId) : null
  );
  if (!selectedStatusFile) {
    throw new Error("Select one running app with statusFile or appId DATA; do not guess an app");
  }
  let status;
  try {
    status = JSON.parse(String(readFile(selectedStatusFile, "utf8")));
  } catch (error) {
    throw new Error(`Running-app status file ${selectedStatusFile} could not be read: ${error.message}`);
  }
  // The current shell-ready owner publishes transport under `attachments`.
  // `shell_attachments` is accepted only for status files written by older
  // openers. Do not merge the two shapes: when the current field exists it is
  // authoritative, including when it intentionally publishes no transport.
  const attachments = status?.attachments ?? status?.shell_attachments ?? {};
  if (status?.lifecycle_state && status.lifecycle_state !== "running") {
    throw new Error("The selected app owner is not running; no request was sent");
  }
  if (status?.runner_state && status.runner_state !== "running") {
    throw new Error("The selected app owner is not running; no request was sent");
  }
  const socketPath = nonEmpty(attachments.forwarding_socket);
  if (socketPath) return { socketPath, statusFile: selectedStatusFile };
  const url = nonEmpty(attachments.http_url);
  if (url && /^https?:\/\//i.test(url)) return { url, statusFile: selectedStatusFile };
  throw new Error(
    `Running-app status file ${selectedStatusFile} publishes no shell transport (no forwarding_socket, no http_url); the app has not opened`,
  );
}

/** A `fetch`-shaped function that carries every request over one Unix-domain socket. The URL's
 *  host is ignored; only its path and query reach the shell. Returns a real `Response`. */
export function fetchOverUnixSocket(socketPath) {
  const selected = nonEmpty(socketPath);
  if (!selected) throw new Error("A socket path is required");
  return (url, init = {}) => new Promise((resolve, reject) => {
    const target = url instanceof URL ? url : new URL(String(url), SOCKET_SESSION_PATH_BASE);
    const request = http.request({
      socketPath: selected,
      method: init.method ?? "GET",
      path: `${target.pathname}${target.search}`,
      headers: plainHeaders(init.headers),
      signal: init.signal,
    }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("error", reject);
      incoming.on("end", () => {
        const status = incoming.statusCode ?? 0;
        const bodyless = status === 204 || status === 304 || status < 200;
        try {
          resolve(new Response(bodyless ? null : Buffer.concat(chunks), {
            status: status < 200 ? 502 : status,
            headers: responseHeaders(incoming.headers),
          }));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", (error) => {
      const failure = new Error(`Current app authority transport unavailable (${error.code ?? error.name}); retry through app identity discovery`);
      failure.code = error.code;
      reject(failure);
    });
    if (init.body != null) request.write(init.body);
    request.end();
  });
}

/**
 * Node's http.request wants a plain object of headers. The fetch API hands
 * callers a `Headers` INSTANCE, whose entries live behind the class rather than
 * on the object, so handing one straight to http.request enumerates nothing and
 * every header silently disappears. Nothing errors: the request goes out bare
 * and the server answers about what it did not receive.
 *
 * That is how a write to the running app failed with
 * BITFIELD_RUNNING_COMMAND_LIST_BASIS_MISMATCH and request_basis: null while the
 * caller was setting the basis header correctly on every request. The header was
 * built, set, passed, and dropped here, one line before the wire.
 *
 * All three shapes the fetch API allows are accepted, because accepting two of
 * them and quietly voiding the third is the defect itself.
 */
function plainHeaders(headers) {
  if (headers == null) return {};
  const out = {};
  if (typeof headers.forEach === "function" && typeof headers.get === "function") {
    headers.forEach((value, name) => {
      out[name] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && pair.length === 2) out[String(pair[0])] = String(pair[1]);
    }
    return out;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value != null) out[name] = String(value);
  }
  return out;
}

function responseHeaders(raw) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (value == null) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, String(one));
  }
  return headers;
}

/** The transport function a session sends through: an explicit `fetchImpl` wins (tests and
 *  callers that bring their own), otherwise the socket the session was opened over, otherwise
 *  the platform `fetch` for a URL. */
function transportFor(session, fetchImpl) {
  if (fetchImpl !== fetch) return fetchImpl;
  return sessionTransports.get(session) ?? fetch;
}

async function currentSession(session) {
  const selector = localSelectors.get(session);
  return selector ? startRunningAppSession(selector) : session;
}

function requestHeadersFor(session) {
  return sessionRequestHeaders.get(session) ?? {};
}

export async function startRunningAppSession({
  url,
  statusFile,
  appId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  requestHeaders,
} = {}) {
  let target = nonEmpty(url);
  let sessionFetch = fetchImpl;
  let socketPath = null;
  if (!target) {
    const transport = findRunningAppTransport({ statusFile, appId });
    if (transport.socketPath) {
      socketPath = transport.socketPath;
      target = SOCKET_SESSION_PATH_BASE;
      if (fetchImpl === fetch) sessionFetch = fetchOverUnixSocket(socketPath);
    } else {
      target = transport.url;
    }
  }
  const retainedRequestHeaders = plainHeaders(requestHeaders);
  const response = await fetchWithTimeout(new URL("/boot", target), {
    headers: { ...retainedRequestHeaders, Accept: "application/json", "Cache-Control": "no-cache" },
  }, timeoutMs, sessionFetch);
  const text = await response.text();
  if (!response.ok) {
    const restrictedBasis = await restrictedRecoveryBasis({
      response,
      text,
      target,
      timeoutMs,
      fetchImpl: sessionFetch,
    });
    if (restrictedBasis) {
      const session = {
        url: target,
        basis: restrictedBasis,
        ...(!nonEmpty(url) ? { appId: nonEmpty(appId), statusFile: nonEmpty(statusFile) ?? statusFileForAppId(appId) } : {}),
      };
      sessionTransports.set(session, sessionFetch);
      sessionRequestHeaders.set(session, retainedRequestHeaders);
      if (!nonEmpty(url)) localSelectors.set(session, { appId, statusFile, timeoutMs, fetchImpl, requestHeaders: retainedRequestHeaders });
      return session;
    }
    throw new RunningAppRequestError(`/boot returned ${response.status}: ${excerpt(text)}`, {
      status: response.status,
      body: text,
      target,
    });
  }
  let boot;
  try {
    boot = JSON.parse(text);
  } catch {
    throw new RunningAppRequestError(`/boot returned invalid JSON: ${excerpt(text)}`, {
      status: response.status,
      body: text,
      target,
    });
  }
  const configs = Array.isArray(boot) ? boot : [];
  const basis = configs[0]?.running_command_list_basis;
  if (typeof basis !== "string" || !basis.trim()) {
    throw new RunningAppRequestError("/boot returned no running_command_list_basis", {
      status: response.status,
      body: text,
      target,
    });
  }
  const session = {
    url: target,
    basis,
    ...(!nonEmpty(url) ? { appId: nonEmpty(appId), statusFile: nonEmpty(statusFile) ?? statusFileForAppId(appId) } : {}),
  };
  sessionTransports.set(session, sessionFetch);
  sessionRequestHeaders.set(session, retainedRequestHeaders);
  if (!nonEmpty(url)) localSelectors.set(session, { appId, statusFile, timeoutMs, fetchImpl, requestHeaders: retainedRequestHeaders });
  return session;
}

/** A topology-recovery shell deliberately returns 503 from /boot and admits only the
 *  recovery targets named in its signed recovery receipt. The target carrier still owns the
 *  current command-list basis and returns it on the normal 428 challenge. Treating every
 *  non-2xx /boot as "unreachable" made the one owner capable of repairing package DATA
 *  unable to reach the engine at the exact moment it was needed.
 *
 *  This path is intentionally narrow: exact schema/code, the fixed generic label-addressed
 *  recovery target must be declared, and the carrier itself must issue the basis challenge.
 *  No basis is guessed from source or persisted state. */
async function restrictedRecoveryBasis({ response, text, target, timeoutMs, fetchImpl }) {
  if (response.status !== 503) return null;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const targets = body?.recovery_receipt?.details?.targets;
  if (body?.schema !== "bitfield.boot.failure"
    || body?.code !== "BITFIELD_BOOT_RESTRICTED_RECOVERY"
    || !Array.isArray(targets)
    || !targets.includes("engine.operation.label-addressed")) return null;

  const challenge = await fetchWithTimeout(
    new URL(targetRequestPath("engine.operation.label-addressed"), target),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation_label: "engine.operation.current-cursor" }),
    },
    timeoutMs,
    fetchImpl,
  );
  const challengeText = await challenge.text();
  let challengeBody = null;
  try {
    challengeBody = JSON.parse(challengeText);
  } catch {
    // Without the exact carrier error body below, refuse the recovery session.
  }
  const basis = nonEmpty(challenge.headers.get(BASIS_HEADER))
    ?? nonEmpty(challengeBody?.running_command_list_basis);
  if (challenge.status !== 428
    || challengeBody?.code !== "BITFIELD_RUNNING_COMMAND_LIST_BASIS_MISMATCH"
    || !basis) return null;
  return basis;
}

export function targetRequestPath(target) {
  const name = nonEmpty(target);
  if (!name) throw new Error("An Envelope target is required");
  return `/target/${name.split("/").map(encodeURIComponent).join("/")}`;
}

export async function sendRequestToRunningApp(
  session,
  target,
  payload,
  { timeoutMs = 30000, fetchImpl = fetch } = {},
) {
  if (!session?.url || !session?.basis) throw new Error("A running-app session is required");
  session = await currentSession(session);
  const response = await fetchWithTimeout(new URL(targetRequestPath(target), session.url), {
    method: "POST",
    headers: {
      ...requestHeadersFor(session),
      Accept: "application/json",
      "Content-Type": "application/json",
      [BASIS_HEADER]: session.basis,
    },
    body: JSON.stringify(payload),
  }, timeoutMs, transportFor(session, fetchImpl));
  const text = await response.text();
  if (!response.ok) {
    throw new RunningAppRequestError(`${target} returned ${response.status}: ${excerpt(text)}`, {
      status: response.status,
      body: text,
      target,
    });
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RunningAppRequestError(`${target} returned invalid JSON: ${excerpt(text)}`, {
      status: response.status,
      body: text,
      target,
    });
  }
}

export function runningAppTargetClient(
  session,
  { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {},
) {
  if (!session?.url || !session?.basis) throw new Error("A running-app session is required");
  return {
    async postBytes(target, bytes, requestOptions = {}) {
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        throw new Error("A non-empty request byte body is required");
      }
      const current = await currentSession(session);
      return fetchWithTimeout(new URL(targetRequestPath(target), current.url), {
        method: "POST",
        headers: {
          ...requestHeadersFor(current),
          ...requestOptions.headers,
          [BASIS_HEADER]: current.basis,
        },
        body: bytes,
      }, requestOptions.timeoutMs ?? timeoutMs, transportFor(current, fetchImpl));
    },
  };
}

export async function sendRequestWithBasisRefresh(
  session,
  target,
  payload,
  { timeoutMs = 30000, fetchImpl = fetch, statusFile, appId } = {},
) {
  try {
    return await sendRequestToRunningApp(session, target, payload, { timeoutMs, fetchImpl });
  } catch (error) {
    if (error?.status !== 428) throw error;
    const fresh = await startRunningAppSession(localSelectors.get(session) ?? {
      url: session.url, statusFile, appId, timeoutMs, fetchImpl,
      requestHeaders: requestHeadersFor(session),
    });
    return sendRequestToRunningApp(fresh, target, payload, { timeoutMs, fetchImpl });
  }
}

export function itemsFromReply(reply) {
  const rows = Array.isArray(reply) ? reply : (reply?.items ?? reply?.results ?? []);
  return Array.isArray(rows) ? rows : [];
}

export async function findCurrentRecords(session, kind, {
  limit = 50,
  include = ["payload"],
  timeoutMs = 30000,
  fetchImpl = fetch,
} = {}) {
  const reply = await sendRequestToRunningApp(session, "slot::find-current-items", {
    operation: "find-current-items",
    in: "published-record",
    where: { all: [{ field: "kind", in: [kind] }] },
    include,
    limit,
  }, { timeoutMs, fetchImpl });
  return itemsFromReply(reply).map((row) => row?.payload ?? row).filter(Boolean);
}

export async function findCurrentItems(session, inScope, where, {
  select,
  include = ["payload"],
  limit = 50,
  timeoutMs = 30000,
  fetchImpl = fetch,
} = {}) {
  const reply = await sendRequestToRunningApp(session, "slot::find-current-items", {
    operation: "find-current-items",
    in: inScope,
    where,
    ...(Array.isArray(select) ? { select } : {}),
    include,
    limit,
  }, { timeoutMs, fetchImpl });
  return itemsFromReply(reply);
}

export async function scanCurrentUnderPath(session, partition, pathLabels, {
  limit = 1000,
  timeoutMs = 30000,
  fetchImpl = fetch,
  statusFile,
  appId,
} = {}) {
  if (!Array.isArray(pathLabels)) throw new Error("pathLabels must be an array");
  if (!Number.isInteger(limit)) throw new Error("limit must be an integer");
  let cursor = 0;
  let pages = 0;
  let entries = [];
  let hitLimit = false;
  do {
    const reply = await sendRequestWithBasisRefresh(session, "engine.operation.label-addressed", {
      operation_label: "engine.operation.scan-current-under-path",
      partition_label: partition,
      path_labels: pathLabels,
      cursor,
      limit,
    }, { timeoutMs, fetchImpl, statusFile, appId });
    if (!Array.isArray(reply.entries)) {
      throw new Error("scan-current-under-path returned no entries array");
    }
    entries = entries.concat(reply.entries);
    hitLimit = reply.hit_limit === true;
    cursor = reply.next_cursor ?? null;
    pages += 1;
  } while (cursor !== null);
  return { entries, pages, hit_limit: hitLimit };
}

export async function readCurrentRecord(session, partition, address, {
  addressMode = "identity_text",
  timeoutMs = 30000,
  fetchImpl = fetch,
} = {}) {
  return sendRequestToRunningApp(session, "engine.operation.label-addressed", {
    operation_label: "engine.operation.read-current",
    ...(nonEmpty(partition) ? { partition_label: partition } : {}),
    address_label: address,
    address_mode: addressMode,
  }, { timeoutMs, fetchImpl });
}

export async function writeRecords(session, writes, {
  timeoutMs = 30000,
  fetchImpl = fetch,
} = {}) {
  if (!Array.isArray(writes) || writes.length === 0 || !nonEmpty(writes[0]?.partition_label)) {
    throw new Error("At least one write with partition_label is required");
  }
  return sendRequestToRunningApp(session, "engine.operation.label-addressed", {
    operation_label: "engine.operation.write-batch",
    partition_label: writes[0].partition_label,
    writes,
  }, { timeoutMs, fetchImpl });
}

/** Execute one declared workflow definition on the running app.
 *
 *  The target and operation are fixed here, so a caller supplies coordinates (a definition id
 *  the app publishes plus the input that definition declares) and never a verb. Steps and
 *  output are excluded from the reply by default because a resident session's output is not
 *  finished when the request returns. */
export async function executeDefinition(session, definitionId, input, {
  includeSteps = false,
  includeOutput = false,
  timeoutMs = 30000,
  fetchImpl = fetch,
} = {}) {
  if (!nonEmpty(definitionId)) throw new Error("A definition id is required");
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Definition input must be an object");
  }
  return sendRequestToRunningApp(session, "slot::workflow", {
    operation: "execute_definition",
    definition_id: definitionId,
    include_steps: includeSteps,
    include_output: includeOutput,
    input,
  }, { timeoutMs, fetchImpl });
}

/** End one resident process session by its exact id.
 *
 *  Sends the owner's own end command; the target and command kind are fixed, so a caller
 *  supplies a session id and nothing else. */
export async function endProcessSession(session, sessionId, { timeoutMs = 30000, fetchImpl = fetch } = {}) {
  if (!nonEmpty(sessionId)) throw new Error("A session id is required");
  return sendRequestToRunningApp(session, "compute.process_session", {
    operation: "append_session_command",
    session_id: sessionId,
    command: { kind: "end_session" },
  }, { timeoutMs, fetchImpl });
}

export async function listRunningAppActions(session, options = {}) {
  const records = await findCurrentRecords(session, "action", { ...options, limit: options.limit ?? 200 });
  return records
    .filter((record) => nonEmpty(record?.id)?.startsWith("action:"))
    .map((record) => ({
      id: record.id,
      name: record.name || "",
      description: record.description || "",
      is_active: record.is_active !== false,
    }));
}

async function fetchWithTimeout(url, init, timeoutMs, fetchImpl) {
  const boundedTimeoutMs = validateTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedTimeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Running app request timed out after ${boundedTimeoutMs} ms`);
      timeoutError.code = "APP_REQUEST_TIMEOUT";
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validateTimeoutMs(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer from 1 through ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function excerpt(value) {
  // Keep nested owner/primitive diagnostics intact; callers need the causal tail.
  return String(value ?? "");
}
