#!/usr/bin/env node
// bitfield-packages/packages/ai-cli-launch-adapters/do-work/read-model-list-from-codex-app-server.mjs
//
// Purpose: a CATALOG COMPATIBILITY CHECK. It asks a Codex binary's app-server
// which models it lists after loading a candidate catalog, proving the consumer
// service parses that file and returns the expected entries. A CLI probe
// (`codex exec -m X`) does not prove that much, because the CLI ignores fields
// the app-server reads as gates.
//
// PROOF LEVEL, stated here because an earlier version of this comment claimed
// to be "the exact path the Desktop picker uses" and that overclaim cost four
// restarts: this is NOT proof that the Desktop model picker renders anything.
// The picker applies its own filter downstream, keeping a model only when it is
// in an app-held allowlist the app refreshes from its vendor's backend, so this
// check passes with 45 models while the menu is empty. Upstream dependency of
// the rendered surface, never a substitute for it. The whole traced path is in
// knowledge/dev-tooling/codex-desktop-model-picker-is-gated-by-an-app-side-allowlist.md
//
// The app-server speaks JSON-RPC over stdio: initialize, then model/list.
// Nothing here names a model or a vendor.
//
// CLI: node read-model-list-from-codex-app-server.mjs --codex <binary> [--codex-home <dir>] [--include-hidden]
// Prints {listed: [slug...], hidden: [slug...]} to stdout.

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

export function readModelListFromCodexAppServer({ codexBinary, codexHome, includeHidden = false, timeoutMs = 30000, spawnImpl = spawn }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (codexHome) env.CODEX_HOME = codexHome;
    const child = spawnImpl(codexBinary, ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`app-server gave no model/list reply within ${timeoutMs}ms; stderr: ${err.slice(-500)}`)); }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n")) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 2 && message.result) {
          clearTimeout(timer);
          child.kill();
          const models = message.result.data ?? message.result.models ?? message.result.items ?? [];
          const slugOf = (m) => m.id ?? m.slug ?? m.model;
          const isHidden = (m) => m.hidden === true || m.visibility === "hide";
          resolve({
            listed: models.filter((m) => !isHidden(m)).map(slugOf),
            hidden: models.filter(isHidden).map(slugOf),
            raw: message.result,
          });
          return;
        }
        if (message.id === 2 && message.error) {
          clearTimeout(timer);
          child.kill();
          reject(new Error(`model/list error: ${JSON.stringify(message.error)}`));
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "ai-cli-launch-adapters", title: "catalog verifier", version: "0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model/list", params: { includeHidden } }) + "\n");
  });
}

function readArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

if (import.meta.url === (process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : '')) {
  const codexBinary = readArg(process.argv, "--codex");
  if (!codexBinary) {
    process.stderr.write("usage: --codex <binary> [--codex-home <dir>] [--include-hidden]\n");
    process.exit(1);
  }
  const result = await readModelListFromCodexAppServer({
    codexBinary,
    codexHome: readArg(process.argv, "--codex-home"),
    includeHidden: process.argv.includes("--include-hidden"),
  });
  const payload = process.argv.includes("--raw") ? result.raw : { listed: result.listed, hidden: result.hidden };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}
