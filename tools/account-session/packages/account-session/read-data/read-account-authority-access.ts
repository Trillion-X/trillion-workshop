import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';

export type VerifiedAccountAuthority = {
  actor_ref: string;
  expires_at_milliseconds: number;
  session_ref: string;
  session_revision: string;
  state: 'active' | 'revoked';
};

/**
 * Normalizes the owner-written authority fact for the hosted carrier without
 * exposing any token, cookie, credential, or account-provider payload.
 */
export function readVerifiedAccountAuthority(value: unknown): VerifiedAccountAuthority | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actor_ref = typeof record.actor_ref === 'string' && record.actor_ref.trim() ? record.actor_ref.trim() : null;
  const session_ref = typeof record.session_ref === 'string' && record.session_ref.trim() ? record.session_ref.trim() : null;
  const revision = record.session_revision;
  const expires = record.expires_at_milliseconds;
  if (!actor_ref || !session_ref || typeof expires !== 'number' || !Number.isFinite(expires) || !Number.isInteger(expires)
    || typeof revision !== 'number' || !Number.isFinite(revision) || !Number.isInteger(revision) || Number(revision) < 1
    || (record.state !== 'active' && record.state !== 'revoked')) return null;
  return {
    actor_ref,
    session_ref,
    session_revision: String(revision),
    expires_at_milliseconds: Number(expires),
    state: record.state,
  };
}

export class AccountAuthorityAccessUnavailableError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function accountAccessPublicUrl() {
  const configured =
    process.env.ACCOUNT_PUBLIC_URL?.trim() ||
    process.env.NEXT_PUBLIC_ACCOUNT_URL?.trim();
  if (!configured) {
    // Fail closed: minting a sign-in link against a fabricated host would
    // email the user a dead URL. The deployment must declare its public URL.
    throw new Error('ACCOUNT_PUBLIC_URL is not configured.');
  }
  return new URL(configured);
}

const EFFECT_LIST_TARGET = 'signed-event-authority.list-effects';

function readJsonReply<T>(payload: Uint8Array): T {
  const text = new TextDecoder().decode(payload);
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

function publicStatus(error: unknown) {
  const status = error && typeof error === 'object'
    ? (error as { publicStatus?: unknown; status?: unknown; statusCode?: unknown }).status
      ?? (error as { publicStatus?: unknown; status?: unknown; statusCode?: unknown }).statusCode
      ?? (error as { publicStatus?: unknown; status?: unknown; statusCode?: unknown }).publicStatus
    : undefined;
  return typeof status === 'number' && Number.isInteger(status) ? status : 502;
}

export async function readAccountAuthorityCanOpen(accountId: string): Promise<boolean> {
  try {
    const reply = await sendRequestToBitfieldTarget({
      target: EFFECT_LIST_TARGET,
      payload: { subject: accountId },
    });
    const body = readJsonReply<{
      accessGranted?: unknown;
      effects?: { material?: Record<string, unknown> }[];
      error?: unknown;
      ok?: unknown;
      status?: unknown;
    }>(reply.payload);
    if (body.ok === false) {
      throw new AccountAuthorityAccessUnavailableError(
        typeof body.error === 'string'
          ? body.error
          : 'Account authority is unavailable.',
        publicStatus(body),
      );
    }
    const explicitAccess = body.effects
      ?.map((effect) => effect.material?.access_granted)
      .find((value) => typeof value === 'boolean');
    return typeof explicitAccess === 'boolean' ? explicitAccess : true;
  } catch (error) {
    if (error instanceof AccountAuthorityAccessUnavailableError) {
      throw error;
    }
    throw new AccountAuthorityAccessUnavailableError(
      error instanceof Error
        ? error.message
        : 'Account authority is unavailable.',
      publicStatus(error),
    );
  }
}
