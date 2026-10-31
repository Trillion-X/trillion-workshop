// tools/send-messages/read-data/check-message-headers.ts
//
// Bounded custom headers on an outgoing email, such as `In-Reply-To` and `References` when replying to a message.
// Header names are token-limited, values reject line breaks (header injection) and cap at 4 KiB. Moved unchanged in
// behaviour from the email sender's request checks (readCustomHeaders, readRequiredString); only the error class name
// lost the provider's name.

const MAX_CUSTOM_HEADERS = 32;
const MAX_CUSTOM_HEADER_VALUE_BYTES = 4_096;
const CUSTOM_HEADER_NAME = /^[A-Za-z0-9-]+$/;

export class MessageRejectedError extends Error {
  public readonly publicStatus = 502;
}

export function readRequiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MessageRejectedError(`${label} is required.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function readCustomHeaders(value: unknown) {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    throw new MessageRejectedError('headers must be an object.');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    throw new MessageRejectedError(`headers must contain at most ${MAX_CUSTOM_HEADERS} entries.`);
  }
  const output: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (!CUSTOM_HEADER_NAME.test(key)) {
      throw new MessageRejectedError(`headers.${key} has an invalid header name.`);
    }
    const headerValue = readRequiredString(item, `headers.${key}`);
    if (/\r|\n/.test(headerValue)) {
      throw new MessageRejectedError(`headers.${key} must not contain a line break.`);
    }
    if (new TextEncoder().encode(headerValue).byteLength > MAX_CUSTOM_HEADER_VALUE_BYTES) {
      throw new MessageRejectedError(
        `headers.${key} exceeds ${MAX_CUSTOM_HEADER_VALUE_BYTES} bytes.`,
      );
    }
    output[key] = headerValue;
  }
  return output;
}
