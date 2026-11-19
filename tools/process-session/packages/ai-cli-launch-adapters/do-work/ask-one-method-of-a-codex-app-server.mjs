#!/usr/bin/env node
// bitfield-packages/packages/ai-cli-launch-adapters/do-work/ask-one-method-of-a-codex-app-server.mjs
//
// Purpose: the generic seam for asking a Codex app-server ONE JSON-RPC method
// over stdio, under a chosen home directory, and reporting the exact result or
// the exact error. Every question about what a harness reports to its own UI
// goes through here instead of a new one-off script per method.
//
// Why generic: the first version of this capability was named for the one
// method it asked (model/list), and the next question needed a different method
// on the same transport. The method is DATA.
//
// Invariants:
// - initialize is sent first, because an app-server rejects anything before it.
// - A JSON-RPC error is returned as data (`{ok:false, error}`), never thrown
//   away, because "this call errors" is usually the answer being looked for.
// - Silence until the timeout is reported with whatever stderr arrived, since
//   an app-server that cannot start says why there and nowhere else.
//
// CLI: node ask-one-method-of-a-codex-app-server.mjs --codex <binary> --method <m>
//        [--params-json '{...}'] [--codex-home <dir>] [--cwd <dir>]

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export function askOneMethodOfACodexAppServer({
  codexBinary,
  codexHome,
  cwd,
  method,
  params = {},
  timeoutMs = 30000,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (codexHome) env.CODEX_HOME = codexHome;
    const child = spawnImpl(codexBinary, ["app-server"], { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const finish = (value) => { clearTimeout(timer); child.kill(); resolve(value); };
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`app-server gave no reply to ${method} within ${timeoutMs}ms; stderr: ${err.slice(-600)}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n")) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 2) continue;
        if (message.error) return finish({ ok: false, error: message.error, stderr: err.slice(-600) });
        return finish({ ok: true, result: message.result });
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "ai-cli-launch-adapters", title: "app-server probe", version: "0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) + "\n");
  });
}

function readArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const codexBinary = readArg(process.argv, "--codex");
  const method = readArg(process.argv, "--method");
  if (!codexBinary || !method) {
    process.stderr.write("usage: --codex <binary> --method <m> [--params-json '{...}'] [--codex-home <dir>] [--cwd <dir>]\n");
    process.exit(1);
  }
  const paramsJson = readArg(process.argv, "--params-json");
  const answer = await askOneMethodOfACodexAppServer({
    codexBinary,
    method,
    params: paramsJson ? JSON.parse(paramsJson) : {},
    codexHome: readArg(process.argv, "--codex-home"),
    cwd: readArg(process.argv, "--cwd"),
  });
  process.stdout.write(JSON.stringify(answer, null, 2) + "\n");
  process.exit(answer.ok ? 0 : 2);
}
