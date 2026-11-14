#!/usr/bin/env node
// Pure Node port of the ai-records-producer output parser.
// Parses AI CLI stdout into structured result/error records.
// DATA-driven: no model/provider/customer/founder names.

import { readFileSync, writeFileSync } from "node:fs";

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const value = args[i + 1] ?? "";
    if (key) out[key.replaceAll("-", "_")] = value;
  }
  return out;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function now() {
  return new Date().toISOString();
}

function addressToken(value, fallback) {
  const raw = String(value ?? (fallback || ""));
  return raw.replace(/[^a-zA-Z0-9._:-]/g, "_");
}

// Extract JSON from stdout. The AI may wrap JSON in markdown fences or prose.
function extractJsonFromText(text) {
  if (!text) return null;
  const trimmed = text.trim();

  // Direct JSON
  try {
    return JSON.parse(trimmed);
  } catch {}

  // Markdown fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {}
  }

  // First JSON object in text
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {}
  }

  return null;
}

function parseJsonText(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function valuesAtPath(value, path) {
  if (!Array.isArray(path)) return value;
  return path.reduce((current, key) => current?.[key], value);
}

function matchesWhere(value, clauses) {
  if (!Array.isArray(clauses)) return true;
  return clauses.every((clause) =>
    clause && typeof clause === "object" &&
    valuesAtPath(value, clause.path) === clause.equals
  );
}

// Apply the transport-owned response extraction descriptor. The descriptor is
// DATA: it can select a collection, filter entries, descend, and select a value.
function extractResponseValues(value, descriptor) {
  if (!descriptor || typeof descriptor !== "object") return [value];
  const selected = descriptor.from ? value?.[descriptor.from] : value;
  const candidates = (Array.isArray(selected) ? selected : [selected])
    .filter((candidate) => candidate !== undefined && candidate !== null)
    .filter((candidate) => matchesWhere(candidate, descriptor.where));
  if (descriptor.then) {
    return candidates.flatMap((candidate) =>
      extractResponseValues(candidate, descriptor.then)
    );
  }
  if (Array.isArray(descriptor.select_path)) {
    return candidates
      .map((candidate) => valuesAtPath(candidate, descriptor.select_path))
      .filter((candidate) => candidate !== undefined && candidate !== null);
  }
  return candidates;
}

function decodeHttpResponse(args, request) {
  const status = Number.parseInt(args.http_status || "0", 10);
  if (!Number.isFinite(status) || status <= 0) return null;
  const encodedBody = parseJsonText(args.http_body_json || "[]", []);
  const bodyText = Array.isArray(encodedBody)
    ? Buffer.from(encodedBody).toString("utf8")
    : typeof encodedBody === "string"
      ? encodedBody
      : JSON.stringify(encodedBody);
  if (status < 200 || status >= 300) {
    const body = parseJsonText(bodyText, null);
    // 429 and 5xx mean the same request may succeed later; every other non-2xx
    // means the request itself is wrong and repeating it changes nothing. That
    // is HTTP, not a vendor convention. Requiring one vendor's error type
    // string left Google's 503 "experiencing high demand, please try again
    // later" marked not retryable, so a transient upstream hiccup reached the
    // person as a permanent failure.
    const rateLimited = status === 429;
    const retryable = rateLimited || status === 408 || status >= 500;
    // What the person reads says what happened to them and what they can do.
    // The provider's status line and body are kept beside it for whoever is
    // debugging, because pasting `HTTP 429: {"error":{"code":"too_many_...` into
    // a chat window tells the person nothing and costs them their sentence.
    return {
      error: rateLimited
        ? "The AI has hit its limit for the moment. Try again in a minute."
        : retryable
          ? "The AI is busy right now. Send that again in a moment."
          : "The AI could not answer that.",
      detail: `HTTP ${status}: ${bodyText.slice(0, 2048)}`,
      text: "",
      errorCode: rateLimited ? "rate_limited" : "command_failed",
      retryable,
      providerModelId: body && typeof body === "object" && typeof body.model === "string" ? body.model : null,
    };
  }
  const body = parseJsonText(bodyText, null);
  if (body === null) return { error: "HTTP response body was not valid JSON", text: "" };
  const descriptor = request?.transport?.response_extract;
  const values = extractResponseValues(body, descriptor);
  const text = values.map((value) =>
    typeof value === "string" ? value : JSON.stringify(value)
  ).join("");
  return {
    error: text ? null : "HTTP response extraction produced no output",
    text,
    providerModelId: typeof body.model === "string" ? body.model : null,
  };
}

// Build items for the note output kind
function buildNoteItems(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  if (Array.isArray(parsed)) {
    return parsed.filter((p) => p && typeof p === "object");
  }
  return [parsed];
}

const args = parseArgs();

const request = readJson(args.request_json || "ai-records-request.json", {});
const stdoutText = args.stdout_text || "";
const stderrText = args.stderr_text || "";
const exitCode = parseInt(args.exit_code || "0", 10);
const outputKind = request.output_kind || "note";
const requestId = request.request_id || "unknown";
const modelId = request.model || request.model_id || null;
const cliId = request.cli_id || null;
const targetGroupRef = request.target_group_ref || null;
const promptHash = request.prompt_hash || null;
const addressedInputSnapshot = request.addressed_input_snapshot || null;

const httpResponse = decodeHttpResponse(args, request);
const responseText = httpResponse?.text ?? stdoutText;
const parsed = extractJsonFromText(responseText);
const items = outputKind === "message" && responseText.trim()
  ? [{ kind: "message", text: responseText.trim() }]
  : parsed ? buildNoteItems(parsed) : [];
const hasError = exitCode !== 0 || Boolean(httpResponse?.error) || items.length === 0;

const output = hasError
  ? {
      records: [
        {
          address: `package::ai-records-producer::error::${addressToken(requestId, "request")}`,
          path: ["current-item", "ai-records-producer-error-index"],
          payload: {
            kind: "ai-records-producer.error",
            request_id: requestId,
            error_code: httpResponse?.errorCode ?? (exitCode !== 0 ? "command_failed" : "no_output"),
            error_message:
              exitCode !== 0
                ? stderrText.slice(0, 2048) || `exit code ${exitCode}`
                : httpResponse?.error || "AI produced no parseable output",
            cli_id: cliId,
            model_id: modelId,
            provider_model_id: httpResponse?.providerModelId ?? null,
            error_detail: httpResponse?.detail ?? null,
            retryable: httpResponse?.retryable === true,
            completed_at: now(),
          },
        },
      ],
      summary: { total: 1, errors: 1, items: 0 },
    }
  : {
      records: [
        {
          address: `package::ai-records-producer::result::${addressToken(requestId, "request")}`,
          path: ["current-item", "ai-records-producer-result-index"],
          payload: {
            kind: "ai-records-producer.result",
            request_id: requestId,
            status: "completed",
            target_group_ref: targetGroupRef,
            output_kind: outputKind,
            prompt_hash: promptHash,
            addressed_input_snapshot: addressedInputSnapshot,
            items,
            cli_id: cliId,
            model_id: modelId,
            provider_model_id: httpResponse?.providerModelId ?? null,
            error_code: null,
            error_message: null,
            completed_at: now(),
          },
        },
      ],
      summary: { total: 1, errors: 0, items: items.length },
    };

const normalizedErrorCode = hasError
  ? httpResponse?.errorCode ?? (exitCode !== 0 ? "command_failed" : "no_output")
  : null;
const normalizedErrorMessage = hasError
  ? exitCode !== 0
    ? stderrText.slice(0, 2048) || `exit code ${exitCode}`
    : httpResponse?.error || "AI produced no parseable output"
  : null;
const resultPayload = hasError
  ? {
      kind: "ai-records-producer.result",
      request_id: requestId,
      status: "error",
      target_group_ref: targetGroupRef,
      output_kind: outputKind,
      prompt_hash: promptHash,
      addressed_input_snapshot: addressedInputSnapshot,
      items: [],
      cli_id: cliId,
      model_id: modelId,
      provider_model_id: httpResponse?.providerModelId ?? null,
      retryable: httpResponse?.retryable === true,
      error_code: normalizedErrorCode,
      error_message: normalizedErrorMessage,
      error_detail: httpResponse?.detail ?? null,
      completed_at: output.records[0].payload.completed_at,
    }
  : output.records[0].payload;

Object.assign(output, {
  items: hasError ? [] : items,
  error_code: normalizedErrorCode,
  error_message: normalizedErrorMessage,
  result_payload: resultPayload,
});

writeFileSync(
  args.output_json || "ai-records.json",
  JSON.stringify(output, null, 2),
  "utf-8",
);
