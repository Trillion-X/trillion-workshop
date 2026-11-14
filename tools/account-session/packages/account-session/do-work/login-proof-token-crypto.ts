import { timingSafeEqual } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import packageContract from '../things-to-store-and-run.json' with { type: 'json' };
import {
  createAccountPortalLoginProofPayload,
  readAccountPortalLoginProofPayload,
  type AccountPortalLoginProofV1,
} from '../read-data/login-proof-token';

type JsonRecord = Record<string, unknown>;

export type AccountPortalLoginProofInput = Omit<
  AccountPortalLoginProofV1,
  'expiresAt' | 'issuedAt' | 'version'
>;

class LoginProofTokenRejectedError extends Error {
  public readonly publicStatus = 502;
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function packageRecords(): readonly JsonRecord[] {
  return Array.isArray(packageContract.things)
    ? packageContract.things.filter(isRecord)
    : [];
}

function readRequiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LoginProofTokenRejectedError(`${label} is required.`);
  }
  return value.trim();
}

function readPositiveInteger(value: unknown, label: string) {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new LoginProofTokenRejectedError(`${label} is required.`);
  }
  return Number(value);
}

function readDescriptor() {
  for (const thing of packageRecords()) {
    const payload = thing.payload;
    if (!isRecord(payload) || payload.kind !== 'account-session-login-proof-signing-descriptor') {
      continue;
    }
    return payload;
  }
  throw new LoginProofTokenRejectedError('Account session login proof signing descriptor is not configured.');
}

function readJsonReply(payload: Uint8Array) {
  const text = new TextDecoder().decode(payload);
  return text.trim() ? JSON.parse(text) as JsonRecord : {};
}

async function readLoginProofSecretHex(descriptor: JsonRecord) {
  const target = readRequiredString(
    descriptor.credential_resolver_target,
    'descriptor.credential_resolver_target',
  );
  const key = readRequiredString(descriptor.credential_key, 'descriptor.credential_key');
  const ttlSeconds = readPositiveInteger(
    descriptor.handle_ttl_seconds,
    'descriptor.handle_ttl_seconds',
  );
  const actorId = readRequiredString(
    descriptor.credential_resolver_actor_id,
    'descriptor.credential_resolver_actor_id',
  );
  const readReply = readJsonReply((await sendRequestToBitfieldTarget({
    target,
    payload: {
      handle_ttl_seconds: ttlSeconds,
      key,
      one_time: true,
      operation: 'read',
    },
  })).payload);
  const handle = readRequiredString(readReply.handle, 'credential handle');
  const resolveReply = readJsonReply((await sendRequestToBitfieldTarget({
    target,
    payload: {
      actor_id: actorId,
      handle,
      operation: 'resolve_handle',
    },
  })).payload);
  return readRequiredString(resolveReply.value, 'resolved credential value');
}

function secretBytes(secretHex: string) {
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) {
    throw new LoginProofTokenRejectedError(
      'Account session login proof credential must be exactly 32 bytes of hex key material.',
    );
  }
  return Uint8Array.from(Buffer.from(secretHex, 'hex'));
}

function signPayload(payload: string, secretHex: string) {
  const signature = blake3(new TextEncoder().encode(payload), {
    key: secretBytes(secretHex),
  });
  return Buffer.from(signature).toString('base64url');
}

function sameSignature(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export async function createSignedAccountPortalLoginProofToken(
  proof: AccountPortalLoginProofInput,
  nowSeconds: number,
) {
  const descriptor = readDescriptor();
  const ttlSeconds = readPositiveInteger(
    descriptor.default_login_link_ttl_seconds,
    'descriptor.default_login_link_ttl_seconds',
  );
  const payload = createAccountPortalLoginProofPayload(proof, ttlSeconds, nowSeconds);
  const signature = signPayload(payload, await readLoginProofSecretHex(descriptor));
  return `b3.${payload}.${signature}`;
}

export async function readSignedAccountPortalLoginProofToken(
  token: string | undefined,
  nowSeconds: number,
): Promise<AccountPortalLoginProofV1 | null> {
  if (!token) return null;
  const [format, payload, signature, extra] = token.split('.');
  if (format !== 'b3' || !payload || !signature || extra) return null;
  const descriptor = readDescriptor();
  const expected = signPayload(payload, await readLoginProofSecretHex(descriptor));
  if (!sameSignature(signature, expected)) return null;
  return readAccountPortalLoginProofPayload(payload, nowSeconds);
}
