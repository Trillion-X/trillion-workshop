#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  endProcessSession,
  executeDefinition,
  findRunningAppTransport,
  listRunningAppActions,
  readCurrentRecord,
  scanCurrentUnderPath,
  sendRequestToRunningApp,
  startRunningAppSession,
} from "../read-data/find-the-running-app-and-send-requests-to-it.mjs";
import { resolveExecuteDefinitionInput } from "../read-data/resolve-execute-definition-input.mjs";

const [command, ...arguments_] = process.argv.slice(2);
const statusFile = optionValue(arguments_, "--status-file") ?? process.env.RUNNING_APP_STATUS_FILE;
const appId = optionValue(arguments_, "--app-id") ?? process.env.RUNNING_APP_APP_ID;
// A hosted app is a running app. `startRunningAppSession` has always taken a
// `url`; only these parsers withheld it, and both selectors above resolve
// against THIS machine. Without this, the only way to inspect a hosted engine
// was to reason from a local app's state and call it evidence, which is how a
// hosted question gets answered with a laptop's answer.
const url = optionValue(arguments_, "--url") ?? process.env.RUNNING_APP_URL;

try {
  if (command === "transport") {
    await startRunningAppSession({ url, statusFile, appId });
    process.stdout.write(JSON.stringify({ app_id: appId ?? null, ready: true }) + "\n");
  } else if (command === "request-target") {
    const target = optionValue(arguments_, "--target");
    if (!target) throw new Error("--target is required");
    const timeoutMs = optionalPositiveIntegerOption(arguments_, "--timeout-ms", { maximum: 600000 });
    const input = JSON.parse(fs.readFileSync(0, "utf8"));
    const session = await startRunningAppSession({ url, statusFile, appId });
    const reply = await sendRequestToRunningApp(session, target, input, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    process.stdout.write(JSON.stringify(reply) + "\n");
  } else if (command === "boot") {
    const session = await startRunningAppSession({ url, statusFile, appId });
    process.stdout.write(JSON.stringify({
      app_id: appId ?? null,
      basis_prefix: session.basis.slice(0, 20),
    }, null, 2) + "\n");
  } else if (command === "actions") {
    const session = await startRunningAppSession({ url, statusFile, appId });
    const filter = optionValue(arguments_, "--filter");
    const needle = filter === null ? null : filter.toLowerCase();
    const nativeLocalFilesActions = [
      { id: "action:read-local-file", name: "read-local-file", is_active: true },
      { id: "action:read-local-file-range", name: "read-local-file-range", is_active: true },
      { id: "action:list-local-directory", name: "list-local-directory", is_active: true },
      { id: "action:write-local-file", name: "write-local-file", is_active: true },
      { id: "action:move-local-path-to-trash", name: "move-local-path-to-trash", is_active: true },
    ];
    const actions = [...(await listRunningAppActions(session)), ...nativeLocalFilesActions]
      .filter((action) => needle === null || action.id.toLowerCase().includes(needle) || String(action.name ?? "").toLowerCase().includes(needle));
    if (arguments_.includes("--json")) {
      process.stdout.write(JSON.stringify(actions, null, 2) + "\n");
    } else {
      for (const action of actions) {
        process.stdout.write(`${action.is_active ? "✓" : "○"} ${action.id}  ${action.name}\n`);
      }
    }
  } else if (command === "read-record") {
    // The OPERATION is not a parameter. `readCurrentRecord` hard-codes
    // `engine.operation.read-current` inside the module and this file cannot
    // reach it. The caller supplies COORDINATES, a partition and an address,
    // never a verb. An `--operation` flag here would convert a read verb into an
    // arbitrary engine channel, which is the one edit that would make everything
    // written about this command false.
    //
    // There is deliberately NO write verb, even though `writeRecords` is
    // exported on the next line of the module. A write into a live runtime has a
    // different risk profile and deserves its own gate rather than a ride on
    // this one.
    const session = await startRunningAppSession({ url, statusFile, appId });
    const reply = await readCurrentRecord(
      session,
      requiredOption(arguments_, "--partition"),
      requiredOption(arguments_, "--address"),
      { addressMode: optionValue(arguments_, "--address-mode") ?? "identity_text" },
    );
    // Printed UNMODIFIED, on purpose. A CLI that reshapes an engine reply becomes
    // a second interpretation of the same data, and the two drift. It also
    // destroys the difference between "this record is absent" and "this request
    // failed", which is exactly the false negative a normalizing parser produced
    // before (`d.get('items') or []` turning every error into a confident zero).
    process.stdout.write(JSON.stringify(reply, null, 2) + "\n");
  } else if (command === "scan-current-under-path") {
    // Like read-record, this CLI names one fixed read verb and caller-supplied
    // coordinates. It cannot become an arbitrary engine-operation channel.
    const session = await startRunningAppSession({ url, statusFile, appId });
    const path = valuesAfter(arguments_, "--path");
    if (path.length === 0) throw new Error("--path is required at least once");
    const reply = await scanCurrentUnderPath(
      session,
      requiredOption(arguments_, "--partition"),
      path,
      { limit: Number(optionValue(arguments_, "--limit") ?? 1000) },
    );
    process.stdout.write(JSON.stringify(reply, null, 2) + "\n");
  } else if (command === "execute-definition") {
    // Run ONE declared action the app already lists under `actions`. The verb is fixed
    // (`execute_definition` on `slot::workflow`) and the caller supplies coordinates: a
    // definition id the app publishes, and the input object that definition declares. This
    // cannot become an arbitrary engine channel because the target and operation are not
    // parameters. It is the same request the app's own record actions send.
    const timeoutMs = optionalPositiveIntegerOption(arguments_, "--timeout-ms", { maximum: 600000 });
    const session = await startRunningAppSession({ url, statusFile, appId });
    const definitionId = requiredOption(arguments_, "--definition-id");
    const input = resolveExecuteDefinitionInput(arguments_);
    let reply;
    try {
      reply = await executeDefinition(session, definitionId, input, {
        includeSteps: arguments_.includes("--include-steps"),
        includeOutput: arguments_.includes("--include-output"),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    } catch (error) {
      if (String(error.message).includes("Definition not found") && !definitionId.startsWith("action:")) {
        throw new Error(`${error.message}\nHint: action IDs are namespaced. Try: --definition-id action:${definitionId}`);
      }
      throw error;
    }
    process.stdout.write(JSON.stringify(reply, null, 2) + "\n");
  } else if (command === "list-running-apps") {
    const storageRoot = path.join(os.homedir(), ".bitfield", "runtime-kit", "app-log-storage-folders");
    const apps = [];
    if (fs.existsSync(storageRoot)) {
      for (const entry of fs.readdirSync(storageRoot)) {
        if (!entry.startsWith("app-log-storage-for-bitfield-app-")) continue;
        const hexSuffix = entry.slice("app-log-storage-for-bitfield-app-".length);
        let appIdDecoded;
        try {
          appIdDecoded = Buffer.from(hexSuffix, "hex").toString("utf8");
        } catch {
          continue;
        }
        // `running` is a /boot ANSWER over the published transport. A status file outlives
        // a close, so its presence proves nothing about the present.
        let transport;
        try {
          transport = findRunningAppTransport({ appId: appIdDecoded });
        } catch {
          continue;
        }
        let running = false;
        try {
          await startRunningAppSession({ appId: appIdDecoded, timeoutMs: 3000 });
          running = true;
        } catch {
          running = false;
        }
        apps.push({
          app_id: appIdDecoded,
          running,
        });
      }
    }
    process.stdout.write(JSON.stringify({ apps }, null, 2) + "\n");
  } else if (command === "end-process-session") {
    // End ONE resident process session by its exact id. The verb is fixed (the owner's
    // own `append_session_command` with `end_session`); the caller supplies the session id
    // the app returned when it started the session. This is the same request
    // process-session's stop target sends, and it cannot become a signal or input channel.
    const session = await startRunningAppSession({ url, statusFile, appId });
    const reply = await endProcessSession(session, requiredOption(arguments_, "--session-id"));
    process.stdout.write(JSON.stringify(reply, null, 2) + "\n");
  } else {
    usage();
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

function optionValue(values, name) {
  const index = values.indexOf(name);
  return index >= 0 ? (values[index + 1] ?? null) : null;
}

function optionalPositiveIntegerOption(values, name, { maximum }) {
  if (!values.includes(name)) return undefined;
  const raw = optionValue(values, name);
  if (raw === null || !/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return parsed;
}

/** Absent means absent: a required coordinate is never invented. */
function requiredOption(values, name) {
  const value = optionValue(values, name);
  if (value == null || value.trim().length === 0) throw new Error(`${name} is required`);
  return value;
}

/** Collect every value following a repeated flag, stopping at the next flag. */
function valuesAfter(values, name) {
  const found = [];
  for (let index = values.indexOf(name); index >= 0 && index < values.length; index += 1) {
    const value = values[index + 1];
    if (value == null || value.startsWith("--")) break;
    found.push(value);
    const next = values.indexOf(name, index + 1);
    if (next < 0) break;
    index = next - 1;
  }
  return found;
}

function usage() {
  const invocation = path.basename(process.argv[1]);
  process.stderr.write(
    `Usage: ${invocation} <transport|boot|actions|read-record> [--json] --status-file PATH | --app-id APP_ID\n` +
    `       list-running-apps\n` +
      `       read-record --partition LABEL --address LABEL [--address-mode MODE]\n` +
      `       scan-current-under-path --partition LABEL --path LABEL [--path LABEL...] [--limit N]\n` +
      `       execute-definition --definition-id ID [--input-json '{...}' | --input-json-file PATH] [--include-steps] [--include-output] [--timeout-ms N]\n` +
      `       end-process-session --session-id ID\n`,
  );
  process.exit(1);
}
