import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import http from "node:http";
import readline from "node:readline";

const serverPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../do-work/serve-running-app-tools-over-mcp.mjs",
);

test("the MCP surface advertises and validates the generic action call", async () => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = [];
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let index;
    while ((index = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      if (line.trim()) replies.push(JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  send(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "call_running_app_action", arguments: { definitionId: "", input: {} } },
  });
  send(child, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "call_running_app_action",
      arguments: { connectionId: "not-declared", definitionId: "action:any", input: {} },
    },
  });
  send(child, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "call_running_app_action",
      arguments: { definitionId: "action:any", input: {}, timeoutMs: 0 },
    },
  });
  child.stdin.end();

  await Promise.race([
    new Promise((resolve) => child.on("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000, "timeout")),
  ]);
  if (child.exitCode === null) child.kill("SIGTERM");

  const listed = replies.find((reply) => reply?.id === 2)?.result?.tools ?? [];
  const names = listed.map((tool) => tool.name);
  assert.ok(names.includes("call_running_app_action"));
  const actionTool = listed.find((tool) => tool.name === "call_running_app_action");
  assert.deepEqual(actionTool.inputSchema.properties.timeoutMs, {
    type: "integer",
    minimum: 1,
    maximum: 600000,
    description: "Optional bounded transport timeout in milliseconds; omitted calls retain the package default",
  });
  const readTool = listed.find((tool) => tool.name === "read_running_app_record");
  assert.deepEqual(readTool.inputSchema.required, ["address"]);
  assert.match(readTool.inputSchema.properties.partition.description, /omit for the selected app/);

  const invalid = replies.find((reply) => reply?.id === 3)?.result;
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /definitionId is required/);

  const unknownConnection = replies.find((reply) => reply?.id === 4)?.result;
  assert.equal(unknownConnection.isError, true);
  assert.match(unknownConnection.content[0].text, /Unknown engine connection id: not-declared/);

  const invalidTimeout = replies.find((reply) => reply?.id === 5)?.error;
  assert.match(invalidTimeout.message, /timeoutMs must be an integer from 1 through 600000/);
});

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

test("a long-lived MCP process follows the owner's replacement socket", { timeout: 10000 }, async (t) => {
  const dir = tempFolder(path.join(tmpdir(), "mcp-move-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statusFile = path.join(dir, "status.json");
  const servers = [];
  for (const name of ["before", "after"]) {
    const socket = path.join(dir, name + ".sock");
    const server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(request.url === "/boot"
        ? [{ running_command_list_basis: name }]
        : { items: [{ payload: { id: "action:" + name } }] }));
    });
    await new Promise(resolve => server.listen(socket, resolve));
    servers.push({ server, socket });
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  writeFileSync(statusFile, JSON.stringify({ shell_attachments: { forwarding_socket: servers[0].socket } }));
  const child = spawn(process.execPath, [serverPath, "--status-file", statusFile], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on("line", line => { const r = JSON.parse(line); pending.get(r.id)?.(r); });
  async function query(id) {
    const result = new Promise(resolve => pending.set(id, resolve));
    send(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_running_app_actions", arguments: {} } });
    const reply = await result;
    assert.equal(reply.error, undefined);
    return JSON.parse(reply.result.content[0].text)[0].id;
  }
  assert.equal(await query(1), "action:before");
  await new Promise(resolve => servers[0].server.close(resolve));
  writeFileSync(statusFile, JSON.stringify({ shell_attachments: { forwarding_socket: servers[1].socket } }));
  assert.equal(await query(2), "action:after");
});
