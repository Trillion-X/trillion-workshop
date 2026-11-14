import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import packageContract from '../things-to-store-and-run.json' with { type: 'json' };
import {
  ResendEmailTemplateError,
  buildEmailMessage,
  selectDescriptor,
} from './render-email';

type ResendEmailRequest = {
  headers?: unknown;
  idempotencyKey?: unknown;
  message?: unknown;
  template?: unknown;
  to?: unknown;
  variables?: unknown;
};

const MAX_CUSTOM_HEADERS = 32;
const MAX_CUSTOM_HEADER_VALUE_BYTES = 4_096;
const CUSTOM_HEADER_NAME = /^[A-Za-z0-9-]+$/;

class ResendEmailRejectedError extends Error {
  public readonly publicStatus = 502;
}

function readRequiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ResendEmailRejectedError(`${label} is required.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function packageRecords(): readonly Record<string, unknown>[] {
  return Array.isArray(packageContract.things)
    ? packageContract.things.filter(isRecord)
    : [];
}

/**
 * Select the email descriptor for this request's `template` (DATA-driven, by
 * template_name). The login-link and onboarding emails are two descriptors; this
 * handler never enumerates them.
 */
function readDescriptor(template: string) {
  try {
    return selectDescriptor(packageRecords(), template);
  } catch (error) {
    if (error instanceof ResendEmailTemplateError) {
      throw new ResendEmailRejectedError(error.message);
    }
    throw error;
  }
}

/** Coerce the caller's `variables` map to required non-empty strings. */
function readVariables(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = readRequiredString(item, `variables.${key}`);
  }
  return output;
}

function readStringField(record: Record<string, unknown>, key: string) {
  return readRequiredString(record[key], `descriptor.${key}`);
}

function readNumberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ResendEmailRejectedError(`descriptor.${key} is required.`);
  }
  return value;
}

function readPositiveInteger(value: unknown, label: string) {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new ResendEmailRejectedError(`${label} is required.`);
  }
  return Number(value);
}

function readStringRecord(value: unknown, label: string) {
  if (!isRecord(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = readRequiredString(item, `${label}.${key}`);
  }
  return output;
}

function readCustomHeaders(value: unknown) {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new ResendEmailRejectedError('headers must be an object.');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    throw new ResendEmailRejectedError(`headers must contain at most ${MAX_CUSTOM_HEADERS} entries.`);
  }
  const output: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!CUSTOM_HEADER_NAME.test(key)) {
      throw new ResendEmailRejectedError(`headers.${key} has an invalid header name.`);
    }
    const headerValue = readRequiredString(item, `headers.${key}`);
    if (/\r|\n/.test(headerValue)) {
      throw new ResendEmailRejectedError(`headers.${key} must not contain a line break.`);
    }
    if (new TextEncoder().encode(headerValue).byteLength > MAX_CUSTOM_HEADER_VALUE_BYTES) {
      throw new ResendEmailRejectedError(
        `headers.${key} exceeds ${MAX_CUSTOM_HEADER_VALUE_BYTES} bytes.`,
      );
    }
    output[key] = headerValue;
  }
  return output;
}

/** Assemble the rendered email for the request's template via the generic renderer. */
function renderRequestedEmail(input: ResendEmailRequest, descriptor: Record<string, unknown>) {
  try {
    return buildEmailMessage(descriptor, readVariables(input.variables), input.message);
  } catch (error) {
    if (error instanceof ResendEmailTemplateError) {
      throw new ResendEmailRejectedError(error.message);
    }
    throw error;
  }
}

type HttpReply = { body?: unknown; body_text?: unknown; error?: unknown; handle?: unknown; status_code?: unknown; success?: unknown };

function readJsonReply(payload: Uint8Array): HttpReply {
  const text = new TextDecoder().decode(payload);
  return text.trim()
    ? JSON.parse(text) as HttpReply
    : {};
}

function readProviderReply(reply: HttpReply): Record<string, unknown> {
  if (isRecord(reply.body)) return reply.body;
  let text = '';
  if (typeof reply.body_text === 'string') {
    text = reply.body_text;
  } else if (Array.isArray(reply.body)) {
    try {
      text = new TextDecoder().decode(Uint8Array.from(reply.body as number[]));
    } catch {
      text = '';
    }
  }
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Extract the provider's own error text from an HTTP reply so a rejection is
 * DIAGNOSABLE (AI-safe-fortress: structured errors with the real reason, never a
 * generic "rejected"). Tries the common http-client reply shapes: `body_text`,
 * a byte-array `body`, then `error`, then the whole reply. Never throws.
 */
function extractReplyDetail(reply: { body?: unknown; body_text?: unknown; error?: unknown }): string {
  if (typeof reply.body_text === 'string' && reply.body_text.trim()) return reply.body_text.trim();
  if (Array.isArray(reply.body)) {
    try {
      const decoded = new TextDecoder().decode(Uint8Array.from(reply.body as number[]));
      if (decoded.trim()) return decoded.trim();
    } catch {
      /* fall through */
    }
  }
  if (typeof reply.error === 'string' && reply.error.trim()) return reply.error.trim();
  try {
    return JSON.stringify(reply);
  } catch {
    return 'unparseable reply';
  }
}

async function mintCredentialHandle(descriptor: Record<string, unknown>, credentialKey: string) {
  const target = readStringField(descriptor, 'credential_resolver_target');
  const ttlSeconds = readPositiveInteger(
    descriptor.handle_ttl_seconds,
    'descriptor.handle_ttl_seconds',
  );
  const reply = readJsonReply((await sendRequestToBitfieldTarget({
    target,
    payload: {
      handle_ttl_seconds: ttlSeconds,
      key: credentialKey,
      one_time: true,
      operation: 'read',
    },
  })).payload);
  if (reply.success !== true) {
    throw new ResendEmailRejectedError(
      typeof reply.error === 'string' ? reply.error : 'Resend credential handle minting failed.',
    );
  }
  return readRequiredString(reply.handle, 'credential handle');
}

async function makeCredentialInjections(descriptor: Record<string, unknown>, http: Record<string, unknown>) {
  const injections = Array.isArray(http.credential_injections) ? http.credential_injections : [];
  const output = [];
  for (const [index, injection] of injections.entries()) {
    if (!isRecord(injection) || !isRecord(injection.placement)) {
      throw new ResendEmailRejectedError(`descriptor.http.credential_injections.${index} is required.`);
    }
    output.push({
      handle: await mintCredentialHandle(
        descriptor,
        readRequiredString(
          injection.credential_key,
          `descriptor.http.credential_injections.${index}.credential_key`,
        ),
      ),
      placement: injection.placement,
    });
  }
  return output;
}

async function makeHttpRequest(input: ResendEmailRequest, descriptor: Record<string, unknown>) {
  const to = readRequiredString(input.to, 'to');
  const message = renderRequestedEmail(input, descriptor);
  const http = isRecord(descriptor.http) ? descriptor.http : {};
  const headers = readStringRecord(http.headers, 'descriptor.http.headers');
  if (typeof input.idempotencyKey === 'string') {
    headers['idempotency-key'] = input.idempotencyKey;
  }
  const providerBody: Record<string, unknown> = {
    from: message.from,
    html: message.html,
    subject: message.subject,
    text: message.text,
    to: [to],
  };
  const customHeaders = readCustomHeaders(input.headers);
  if (Object.keys(customHeaders).length > 0) providerBody.headers = customHeaders;
  return {
    url: readStringField(http, 'url'),
    method: readStringField(http, 'method'),
    headers,
    body: Array.from(new TextEncoder().encode(JSON.stringify(providerBody))),
    credential_injections: await makeCredentialInjections(descriptor, http),
    timeout_ms: readNumberField(http, 'timeout_ms'),
  };
}

export async function sendResendEmail(input: ResendEmailRequest) {
  const template = readRequiredString(input.template, 'template');
  const descriptor = readDescriptor(template);
  // Ask the leaf HTTP slot DIRECTLY — never route a single HTTP call THROUGH
  // slot::workflow. The old workflow trampoline (execute_definition
  // action:send-resend-email) re-entered slot::workflow, which deadlocks the
  // persistent workflow component whenever this handler is itself invoked from
  // inside a workflow step (e.g. the onboarding generic resolver). Asking
  // slot::http-client directly makes that re-entrancy category structurally
  // impossible for every caller. See plan
  // 2026-06-30-onboarding-email-delivery-l93-corrected.md (L055/L063).
  const httpTarget =
    typeof descriptor.http_target === 'string' ? descriptor.http_target : 'slot::http-client';
  const reply = readJsonReply(
    (
      await sendRequestToBitfieldTarget({
        target: httpTarget,
        payload: await makeHttpRequest(input, descriptor),
      })
    ).payload,
  );
  const statusCode = typeof reply.status_code === 'number' ? reply.status_code : 0;
  if (statusCode < 200 || statusCode >= 300) {
    // Surface the ACTUAL Resend status + error body (never a generic "rejected"):
    // a 401 = bad/stale `resend-api-key` handle, 403 = account/domain restriction,
    // 422 = invalid from/to. Without this, every failure is undiagnosable.
    throw new ResendEmailRejectedError(
      `Resend rejected the email request (HTTP ${statusCode}): ${extractReplyDetail(reply).slice(0, 800)}`,
    );
  }
  const providerReply = readProviderReply(reply);
  const providerMessageId = readRequiredString(
    providerReply.id,
    'Resend response id',
  );
  return {
    ok: true,
    provider_message_id: providerMessageId,
    status_code: statusCode,
  };
}
