import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from "node:assert/strict";
import { writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import {
  endProcessSession,
  executeDefinition,
  fetchOverUnixSocket,
  findCurrentRecords,
  findRunningAppTransport,
  listRunningAppActions,
  readCurrentRecord,
  RunningAppRequestError,
  runningAppTargetClient,
  scanCurrentUnderPath,
  sendRequestToRunningApp,
  SOCKET_SESSION_PATH_BASE,
  startRunningAppSession,
  statusFileForAppId,
  writeRecords,
} from "../read-data/find-the-running-app-and-send-requests-to-it.mjs";
import { resolveExecuteDefinitionInput } from "../read-data/resolve-execute-definition-input.mjs";

test("package DATA never persists private app forwarding transport", () => {
  const packages = new URL("../../", import.meta.url);
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = new URL(`${entry.name}/things-to-store-and-run.json`, packages);
    if (!existsSync(manifest)) continue;
    assert.doesNotMatch(readFileSync(manifest, "utf8"), /bf-fwd-|forwarding_socket|shell_socket_path|carrier_socket_path/, entry.name);
  }
});

test("the current shell-ready owner publishes a socket path and that exact transport is read", () => {
  const home = tempFolder(path.join(tmpdir(), "running-app-owner-"));
  const statusFile = path.join(home, "this-bitfield-shell-is-ready.json");
  writeFileSync(statusFile, JSON.stringify({
    schema: "bitfield.this_bitfield_shell_is_ready",
    runner_state: "running",
    attachments: { forwarding_socket: "/tmp/one-app/shell.sock" },
  }));
  assert.deepEqual(findRunningAppTransport({ statusFile }), { socketPath: "/tmp/one-app/shell.sock", statusFile });
});

test("a legacy owner status remains readable without overriding the current attachment field", () => {
  const home = tempFolder(path.join(tmpdir(), "running-app-owner-"));
  const legacyStatusFile = path.join(home, "legacy-status.json");
  writeFileSync(legacyStatusFile, JSON.stringify({
    shell_attachments: { forwarding_socket: "/tmp/legacy-app/shell.sock" },
  }));
  assert.deepEqual(findRunningAppTransport({ statusFile: legacyStatusFile }), {
    socketPath: "/tmp/legacy-app/shell.sock",
    statusFile: legacyStatusFile,
  });

  const currentStatusFile = path.join(home, "current-status.json");
  writeFileSync(currentStatusFile, JSON.stringify({
    attachments: {},
    shell_attachments: { forwarding_socket: "/tmp/stale-app/shell.sock" },
  }));
  assert.throws(
    () => findRunningAppTransport({ statusFile: currentStatusFile }),
    /publishes no shell transport/,
  );
});

test("a deployment that declared a TCP listen address is reached by the URL it published", () => {
  const home = tempFolder(path.join(tmpdir(), "running-app-owner-"));
  const statusFile = path.join(home, "runtime-app-authority-status.json");
  writeFileSync(statusFile, JSON.stringify({ shell_attachments: { http_url: "http://store.example:8080" } }));
  assert.deepEqual(findRunningAppTransport({ statusFile }), { url: "http://store.example:8080", statusFile });
});

test("an owner that has published no transport is an app that has not opened, never a guess", () => {
  const home = tempFolder(path.join(tmpdir(), "running-app-owner-"));
  const statusFile = path.join(home, "runtime-app-authority-status.json");
  writeFileSync(statusFile, JSON.stringify({ shell_attachments: {} }));
  assert.throws(() => findRunningAppTransport({ statusFile }), /publishes no shell transport/);
});

test("a stopped current shell-ready owner is refused before its stale socket can be dialled", () => {
  const home = tempFolder(path.join(tmpdir(), "running-app-owner-"));
  const statusFile = path.join(home, "this-bitfield-shell-is-ready.json");
  writeFileSync(statusFile, JSON.stringify({
    runner_state: "stopped",
    attachments: { forwarding_socket: "/tmp/stale-app/shell.sock" },
  }));
  assert.throws(() => findRunningAppTransport({ statusFile }), /not running/);
});

test("no app is guessed when owner DATA is absent", () => {
  assert.throws(() => findRunningAppTransport({}), /Select one running app/);
});

test("the status file path is a pure function of the app id and carries no address", () => {
  const file = statusFileForAppId("trillion", { home: "/home/someone" });
  assert.equal(file.includes("app-log-storage-for-bitfield-app-7472696c6c696f6e"), true);
  assert.equal(file.endsWith("running-now/open-this-bitfield-app/runtime-app-authority-status.json"), true);
  assert.equal(file.includes("127.0.0.1"), false);
  assert.equal(file.includes("http"), false);
  assert.throws(() => statusFileForAppId("../escape"), /Invalid running-app id/);
});

test("a session over a Unix socket boots and sends targets with no network address anywhere", async () => {
  const home = tempFolder(path.join(tmpdir(), "running-app-socket-"));
  const socketPath = path.join(home, "shell.sock");
  const seen = [];
  const server = http.createServer((request, reply) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, basis: request.headers["x-bitfield-running-command-list-basis"], body });
      reply.setHeader("Content-Type", "application/json");
      if (request.url === "/boot") {
        reply.end(JSON.stringify([{ running_command_list_basis: "basis:socket" }]));
      } else {
        reply.end(JSON.stringify({ items: [{ payload: { id: "action:over-socket", name: "Over socket" } }] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const statusFile = path.join(home, "runtime-app-authority-status.json");
    writeFileSync(statusFile, JSON.stringify({ shell_attachments: { forwarding_socket: socketPath } }));

    const session = await startRunningAppSession({ statusFile });
    assert.equal(session.basis, "basis:socket");
    assert.equal(session.socketPath, undefined);
    assert.equal(JSON.stringify(session).includes(socketPath), false);
    assert.equal(session.url, SOCKET_SESSION_PATH_BASE);

    const actions = await listRunningAppActions(session);
    assert.deepEqual(actions, [{ id: "action:over-socket", name: "Over socket", description: "", is_active: true }]);
    assert.equal(seen[0].url, "/boot");
    const sent = seen.find(row => row.method === "POST");
    assert.equal(sent.url, "/target/slot%3A%3Afind-current-items");
    assert.equal(sent.basis, "basis:socket");

    const direct = await fetchOverUnixSocket(socketPath)(new URL("/boot", SOCKET_SESSION_PATH_BASE));
    assert.equal(direct.ok, true);
    assert.equal(direct.headers.get("content-type"), "application/json");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an exact status file cannot be confused with another installation sharing the same app id", async () => {
  const home = tempFolder(path.join(tmpdir(), "same-id-installations-"));
  const installations = [];
  for (const name of ["canonical", "blank-customer-proof"]) {
    const socketPath = path.join(home, `${name}.sock`);
    const server = http.createServer((request, reply) => {
      request.resume();
      request.on("end", () => {
        reply.setHeader("Content-Type", "application/json");
        reply.end(JSON.stringify(request.url === "/boot"
          ? [{ running_command_list_basis: `basis:${name}` }]
          : { installation: name }));
      });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    const statusFile = path.join(home, `${name}-this-bitfield-shell-is-ready.json`);
    writeFileSync(statusFile, JSON.stringify({
      schema: "bitfield.this_bitfield_shell_is_ready",
      runner_state: "running",
      attachments: { forwarding_socket: socketPath },
    }), { flag: "w" });
    installations.push({ name, server, statusFile });
  }

  try {
    const selected = installations[0];
    const session = await startRunningAppSession({
      statusFile: selected.statusFile,
      appId: "trillion",
    });
    assert.equal(session.basis, "basis:canonical");
    assert.equal(session.statusFile, selected.statusFile);
    assert.equal((await sendRequestToRunningApp(session, "fixture", {})).installation, "canonical");
  } finally {
    await Promise.all(installations.map(({ server }) => new Promise((resolve) => server.close(resolve))));
  }
});

test("retained concurrent consumers follow repeated authority turnover and refuse unavailable status", async () => {
  const home = tempFolder(path.join(tmpdir(), "authority-turnover-"));
  const statusFile = path.join(home, "status.json");
  const servers = [];
  const publish = (generation, lifecycle_state = "running") => writeFileSync(statusFile, JSON.stringify({
    lifecycle_state, generation, shell_attachments: { forwarding_socket: path.join(home, `owner-${generation}.sock`) },
  }));
  try {
    for (let generation = 1; generation <= 3; generation++) {
      const server = http.createServer((request, reply) => {
        request.resume();
        request.on("end", () => {
          reply.setHeader("Content-Type", "application/json");
          if (request.url === "/boot") reply.end(JSON.stringify([{ running_command_list_basis: `basis:${generation}` }]));
          else {
            assert.equal(request.headers["x-bitfield-running-command-list-basis"], `basis:${generation}`);
            reply.end(JSON.stringify({ generation }));
          }
        });
      });
      await new Promise(resolve => server.listen(path.join(home, `owner-${generation}.sock`), resolve));
      servers.push(server);
    }
    publish(1);
    const first = await startRunningAppSession({ statusFile });
    const second = await startRunningAppSession({ statusFile });
    const bytes = runningAppTargetClient(second);
    for (let generation = 1; generation <= 3; generation++) {
      publish(generation);
      const answers = await Promise.all([
        sendRequestToRunningApp(first, "fixture", {}),
        sendRequestToRunningApp(second, "fixture", {}),
        bytes.postBytes("fixture", Buffer.from("{}")).then(response => response.json()),
      ]);
      assert.deepEqual(answers.map(answer => answer.generation), [generation, generation, generation]);
    }
    publish(3, "stopped");
    await assert.rejects(sendRequestToRunningApp(first, "fixture", {}), /not running/);
    writeFileSync(statusFile, "{}");
    await assert.rejects(bytes.postBytes("fixture", Buffer.from("{}")), /no shell transport/);
    writeFileSync(statusFile, "invalid");
    await assert.rejects(sendRequestToRunningApp(second, "fixture", {}), /could not be read/);
    publish(2);
    assert.equal((await sendRequestToRunningApp(first, "fixture", {})).generation, 2);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
});

test("boot session and target requests use Envelope target addresses", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (url.pathname === "/boot") {
      return response(200, [{ running_command_list_basis: "basis:test" }]);
    }
    return response(200, { items: [{ payload: { id: "action:test", name: "Do work" } }] });
  };
  const session = await startRunningAppSession({ url: "http://127.0.0.1:55555", fetchImpl });
  const actions = await listRunningAppActions(session, { fetchImpl });
  assert.equal(session.basis, "basis:test");
  assert.deepEqual(actions, [{ id: "action:test", name: "Do work", description: "", is_active: true }]);
  assert.equal(calls[1].url, "http://127.0.0.1:55555/target/slot%3A%3Afind-current-items");
  assert.equal(calls[1].init.headers["X-Bitfield-Running-Command-List-Basis"], "basis:test");
});

test("private hosted sessions carry ephemeral request headers to boot and target requests", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (url.pathname === "/boot") {
      return response(200, [{ running_command_list_basis: "basis:private" }]);
    }
    return response(200, { ok: true });
  };
  const session = await startRunningAppSession({
    url: "https://private.example",
    fetchImpl,
    requestHeaders: { Cookie: "private-session=value" },
  });
  await sendRequestToRunningApp(session, "fixture", {}, { fetchImpl });
  assert.equal(calls[0].init.headers.Cookie, "private-session=value");
  assert.equal(calls[1].init.headers.Cookie, "private-session=value");
  assert.equal(JSON.stringify(session).includes("private-session"), false);
});

test("restricted topology recovery discovers the carrier basis and keeps the repair owner reachable", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (new URL(String(url)).pathname === "/boot") {
      return response(503, {
        schema: "bitfield.boot.failure",
        code: "BITFIELD_BOOT_RESTRICTED_RECOVERY",
        recovery_receipt: {
          details: {
            targets: [
              "engine.operation",
              "engine.operation.label-addressed",
              "package-set-runtime-state.apply-package-delta",
            ],
          },
        },
      });
    }
    if (!init.headers?.["X-Bitfield-Running-Command-List-Basis"]) {
      return response(428, {
        code: "BITFIELD_RUNNING_COMMAND_LIST_BASIS_MISMATCH",
        running_command_list_basis: "basis:recovery",
      }, { "X-Bitfield-Running-Command-List-Basis": "basis:recovery" });
    }
    return response(200, { cursor: 9 });
  };

  const session = await startRunningAppSession({ url: "http://127.0.0.1:55555", fetchImpl });
  assert.equal(session.basis, "basis:recovery");
  const reply = await sendRequestToRunningApp(session, "engine.operation.label-addressed", {
    operation_label: "engine.operation.current-cursor",
    partition_label: "selected-partition",
  }, { fetchImpl });
  assert.equal(reply.cursor, 9);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, "http://127.0.0.1:55555/target/engine.operation.label-addressed");
  assert.equal(calls[2].init.headers["X-Bitfield-Running-Command-List-Basis"], "basis:recovery");
});

test("recovery discovery refuses unrelated boot failures before probing a target", async () => {
  for (const boot of [
    { schema: 'other', code: 'BITFIELD_BOOT_RESTRICTED_RECOVERY', recovery_receipt: { details: { targets: ['engine.operation.label-addressed'] } } },
    { schema: 'bitfield.boot.failure', code: 'OTHER_FAILURE', recovery_receipt: { details: { targets: ['engine.operation.label-addressed'] } } },
    { schema: 'bitfield.boot.failure', code: 'BITFIELD_BOOT_RESTRICTED_RECOVERY', recovery_receipt: { details: { targets: [] } } },
  ]) {
    let calls = 0;
    await assert.rejects(startRunningAppSession({ url: 'http://127.0.0.1:55555', fetchImpl: async () => {
      calls++;
      return response(503, boot);
    } }), /boot returned 503/);
    assert.equal(calls, 1);
  }
});

test("recovery discovery requires the exact carrier challenge and a nonempty basis", async () => {
  for (const [status, code, basis] of [
    [200, 'BITFIELD_RUNNING_COMMAND_LIST_BASIS_MISMATCH', 'basis:unexpected-success'],
    [428, 'OTHER_FAILURE', 'basis:wrong-code'],
    [428, 'BITFIELD_RUNNING_COMMAND_LIST_BASIS_MISMATCH', ''],
  ]) {
    let calls = 0;
    await assert.rejects(startRunningAppSession({ url: 'http://127.0.0.1:55555', fetchImpl: async () => {
      calls++;
      if (calls === 1) return response(503, {
        schema: 'bitfield.boot.failure', code: 'BITFIELD_BOOT_RESTRICTED_RECOVERY',
        recovery_receipt: { details: { targets: ['engine.operation.label-addressed'] } },
      });
      return response(status, { code, running_command_list_basis: basis });
    } }), /boot returned 503/);
    assert.equal(calls, 2);
  }
});

test("request failures keep HTTP status and response body", async () => {
  const diagnostic = "workflow context ".repeat(30) + "compute.process: descendant-containment: authority unavailable";
  const fetchImpl = async () => response(500, { error: "engine closed", message: diagnostic });
  const session = { url: "http://127.0.0.1:55555", basis: "basis:test" };
  await assert.rejects(
    () => sendRequestToRunningApp(session, "engine.operation.label-addressed", {}, { fetchImpl }),
    (error) => error instanceof RunningAppRequestError && error.status === 500 && error.body.includes("engine closed") && error.message.includes(diagnostic),
  );
});

test("byte target clients preserve canonical request bytes and the selected basis", async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return response(200, { ok: true });
  };
  const client = runningAppTargetClient(
    { url: "http://127.0.0.1:55555", basis: "basis:test" },
    { fetchImpl },
  );
  const bytes = new TextEncoder().encode('{"operation_label":"engine.operation.read-current"}');
  const actual = await client.postBytes("engine.operation.label-addressed", bytes, {
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(actual.status, 200);
  assert.equal(calls[0].url, "http://127.0.0.1:55555/target/engine.operation.label-addressed");
  assert.equal(calls[0].init.body, bytes);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].init.headers["X-Bitfield-Running-Command-List-Basis"], "basis:test");
});

test("record queries and writes preserve the generic Envelope operation shapes", async () => {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) });
    return response(200, { items: [{ payload: { id: "row:one" } }] });
  };
  const session = { url: "http://127.0.0.1:55555", basis: "basis:test" };
  const records = await findCurrentRecords(session, "content-generation.recipe", { fetchImpl });
  await readCurrentRecord(session, undefined, "package::documents::documents::one", { fetchImpl });
  await readCurrentRecord(session, "selected-partition", "selected-address", { fetchImpl });
  await writeRecords(session, [{
    partition_label: "selected-partition",
    address_label: "selected-address",
    address_mode: "identity_text",
    path_labels: ["current-item", "published-record"],
    payload: { id: "row:one" },
  }], { fetchImpl });
  assert.deepEqual(records, [{ id: "row:one" }]);
  assert.equal(sent[0].body.operation, "find-current-items");
  assert.deepEqual(sent[1].body, {
    operation_label: "engine.operation.read-current",
    address_label: "package::documents::documents::one",
    address_mode: "identity_text",
  });
  assert.equal(sent[2].body.partition_label, "selected-partition");
  assert.equal(sent[3].body.operation_label, "engine.operation.write-batch");
});

test("executing a definition fixes the target and verb and passes only coordinates", async () => {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    sent.push({ path: new URL(String(url)).pathname, body: JSON.parse(init.body) });
    return response(200, { ok: true });
  };
  const session = { url: "http://127.0.0.1:55555", basis: "basis:test" };
  await executeDefinition(session, "action:declared", { carrier_url: "http://127.0.0.1:55555" }, { fetchImpl });
  assert.equal(sent[0].path, "/target/slot%3A%3Aworkflow");
  assert.deepEqual(sent[0].body, {
    operation: "execute_definition",
    definition_id: "action:declared",
    include_steps: false,
    include_output: false,
    input: { carrier_url: "http://127.0.0.1:55555" },
  });
  await assert.rejects(executeDefinition(session, "", {}, { fetchImpl }), /definition id is required/);
  await assert.rejects(executeDefinition(session, "action:declared", [], { fetchImpl }), /must be an object/);
  await endProcessSession(session, "process_session:1f:abc", { fetchImpl });
  assert.equal(sent[1].path, "/target/compute.process_session");
  assert.deepEqual(sent[1].body, {
    operation: "append_session_command",
    session_id: "process_session:1f:abc",
    command: { kind: "end_session" },
  });
  await assert.rejects(endProcessSession(session, " ", { fetchImpl }), /session id is required/);
});

test("definition execution uses the bounded default and honors an explicit timeout", async () => {
  const observedTimeouts = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (_callback, delay) => {
    observedTimeouts.push(delay);
    return { delay };
  };
  globalThis.clearTimeout = () => {};
  const fetchImpl = async () => response(200, { ok: true });
  const session = { url: "http://127.0.0.1:55555", basis: "basis:test" };
  try {
    await executeDefinition(session, "action:default-timeout", {}, { fetchImpl });
    await executeDefinition(session, "action:explicit-timeout", {}, { fetchImpl, timeoutMs: 120000 });
    await assert.rejects(
      executeDefinition(session, "action:invalid-timeout", {}, { fetchImpl, timeoutMs: 1800001 }),
      /timeoutMs must be an integer from 1 through 1800000/,
    );
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
  assert.deepEqual(observedTimeouts, [30000, 120000]);
});

test("definition deadline is reported as a timeout rather than a missing app transport", async () => {
  const session = { url: "http://127.0.0.1:55555", basis: "basis:test" };
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { code: "ABORT_ERR" })), { once: true });
  });
  await assert.rejects(
    executeDefinition(session, "action:slow", {}, { fetchImpl, timeoutMs: 5 }),
    (error) => error.code === "APP_REQUEST_TIMEOUT" && /timed out after 5 ms/.test(error.message),
  );
});

test("path scans preserve every cursor instead of treating one full page as the end", async () => {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    sent.push(JSON.parse(init.body));
    const firstPage = sent.length === 1;
    return response(200, firstPage
      ? { entries: [{ address: "row:one" }], next_cursor: 77, hit_limit: true }
      : { entries: [{ address: "row:two" }], next_cursor: null, hit_limit: false });
  };
  const reply = await scanCurrentUnderPath(
    { url: "http://127.0.0.1:55555", basis: "basis:test" },
    "selected-partition",
    ["current-item", "send-later-request"],
    { limit: 1, fetchImpl },
  );
  assert.deepEqual(reply, {
    entries: [{ address: "row:one" }, { address: "row:two" }],
    pages: 2,
    hit_limit: false,
  });
  assert.deepEqual(sent.map((body) => ({
    operation_label: body.operation_label,
    partition_label: body.partition_label,
    path_labels: body.path_labels,
    cursor: body.cursor,
    limit: body.limit,
  })), [
    {
      operation_label: "engine.operation.scan-current-under-path",
      partition_label: "selected-partition",
      path_labels: ["current-item", "send-later-request"],
      cursor: 0,
      limit: 1,
    },
    {
      operation_label: "engine.operation.scan-current-under-path",
      partition_label: "selected-partition",
      path_labels: ["current-item", "send-later-request"],
      cursor: 77,
      limit: 1,
    },
  ]);
});

function response(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Pins the header-normalization done by the unix-socket transport.
 *
 * The regression this locks: Node's http.request wants a plain object of
 * headers. The fetch API allows three shapes, a Headers instance, an array of
 * pairs, and a plain object. Passing a Headers instance straight through
 * enumerates nothing, silently drops every header, and the server answers
 * about a request it never received. That produced a
 * BITFIELD_RUNNING_COMMAND_LIST_BASIS_MISMATCH with request_basis: null while
 * the caller was correctly setting the basis header on every request.
 *
 * All three shapes must reach the server intact. If any shape starts dropping
 * headers again, this test fails at the shape that regressed instead of
 * surfacing three time zones downstream as "your basis is missing."
 */
test("fetchOverUnixSocket forwards headers from all three fetch API shapes", async () => {
  const home = tempFolder(path.join(tmpdir(), "socket-header-shapes-"));
  const socketPath = path.join(home, "shell.sock");
  const seenPerRequest = [];
  const server = http.createServer((request, response) => {
    seenPerRequest.push({
      "x-shape-marker": request.headers["x-shape-marker"] ?? null,
      "x-second-header": request.headers["x-second-header"] ?? null,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));

  try {
    const socketFetch = fetchOverUnixSocket(socketPath);
    const targetUrl = new URL("/probe", SOCKET_SESSION_PATH_BASE);

    await socketFetch(targetUrl, {
      headers: new Headers({ "x-shape-marker": "headers-instance", "x-second-header": "one" }),
    });
    await socketFetch(targetUrl, {
      headers: [["x-shape-marker", "array-of-pairs"], ["x-second-header", "two"]],
    });
    await socketFetch(targetUrl, {
      headers: { "x-shape-marker": "plain-object", "x-second-header": "three" },
    });

    assert.equal(seenPerRequest[0]["x-shape-marker"], "headers-instance");
    assert.equal(seenPerRequest[0]["x-second-header"], "one");
    assert.equal(seenPerRequest[1]["x-shape-marker"], "array-of-pairs");
    assert.equal(seenPerRequest[1]["x-second-header"], "two");
    assert.equal(seenPerRequest[2]["x-shape-marker"], "plain-object");
    assert.equal(seenPerRequest[2]["x-second-header"], "three");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("large declared-action input loads from one file without putting payload bytes in argv", () => {
  const value = resolveExecuteDefinitionInput(["--input-json-file", "/request.json"], {
    readFile: (filePath, encoding) => {
      assert.equal(filePath, "/request.json");
      assert.equal(encoding, "utf8");
      return JSON.stringify({ graph: { spans: Array.from({ length: 10_000 }, (_, index) => ({ id: index })) } });
    },
  });
  assert.equal(value.graph.spans.length, 10_000);
});

test("declared-action input rejects ambiguous, non-object, and invalid values", () => {
  assert.throws(() => resolveExecuteDefinitionInput(["--input-json", "{}", "--input-json-file", "/request.json"]), /exactly one/);
  assert.throws(() => resolveExecuteDefinitionInput(["--input-json", "[]"]), /JSON object/);
  assert.throws(() => resolveExecuteDefinitionInput(["--input-json", "not-json"]), /JSON object/);
});
