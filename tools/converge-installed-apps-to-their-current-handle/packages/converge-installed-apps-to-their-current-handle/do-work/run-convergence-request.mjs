#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { convergeOneInstalledAppToItsCurrentHandle } from "./converge-installed-apps-to-their-current-handle.mjs";

const requestPath = process.argv[2];
const resultPath = process.argv[3];
if (!requestPath || !resultPath) throw new Error("request and result paths are required");

const request = JSON.parse(await readFile(requestPath, "utf8"));
const appIds = Array.isArray(request.app_ids) ? request.app_ids : [];
if (appIds.length === 0) throw new Error("app_ids must contain at least one app");
if (new Set(appIds).size !== appIds.length) throw new Error("app_ids must not contain duplicates");

const each = [];
for (const appId of appIds) {
  try {
    each.push(await convergeOneInstalledAppToItsCurrentHandle({
      appId,
      ...(request.timeout_ms == null ? {} : { spawnTimeoutMs: request.timeout_ms }),
    }));
  } catch (error) {
    each.push({ app_id: appId, converged: false, error: String(error?.message ?? error) });
  }
}

const result = {
  kind: "installed-app-convergence-result",
  application_id: request.application_id ?? null,
  installation_ref: request.installation_ref ?? null,
  change_ref: request.change_ref ?? null,
  asked: each.length,
  converged: each.filter((row) => row.converged === true).length,
  not_converged: each.filter((row) => row.converged !== true).map((row) => row.app_id),
  each,
};
await writeFile(resultPath, JSON.stringify(result));
if (result.not_converged.length > 0) process.exitCode = 1;
