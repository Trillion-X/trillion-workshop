import { safeAccountId } from './safe-account-id';

export type AccountPortalLoginProofV1 = {
  accountId: string;
  browserId?: string;
  desktopHandoff?: { request_id: string; code_challenge: string; code_challenge_method: 'S256' };
  emailHash: string;
  expiresAt: number;
  issuedAt: number;
  nonce: string;
  returnPath: string;
  version: 1;
};

export const MAX_RETURN_PATH_LENGTH = 2048;

export function safeReturnPath(value: unknown) {
  if (typeof value !== 'string') return '/account';
  const path = value.trim();
  if (!path.startsWith('/') || path.startsWith('//')) return '/account';
  if (path.includes('\n') || path.includes('\r') || path.length > MAX_RETURN_PATH_LENGTH) {
    return '/account';
  }
  return path;
}

export function base64urlLoginProofJson(value: AccountPortalLoginProofV1) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function safeEmailHash(value: unknown) {
  if (typeof value !== 'string') return null;
  const hash = value.trim();
  if (!/^1f:[0-9a-f]{64}$/i.test(hash)) return null;
  return hash;
}

function safeNonce(value: unknown) {
  if (typeof value !== 'string') return null;
  const nonce = value.trim();
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) return null;
  return nonce;
}

export function safeBrowserId(value: unknown) {
  if (typeof value !== 'string') return null;
  const browserId = value.trim();
  if (!/^browser:[a-zA-Z0-9._:-]{8,200}$/.test(browserId)) return null;
  return browserId;
}

function safeDesktopHandoff(value: unknown): AccountPortalLoginProofV1['desktopHandoff'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['request_id', 'code_challenge', 'code_challenge_method'].includes(key))
    || typeof row.request_id !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(row.request_id)
    || typeof row.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(row.code_challenge)
    || row.code_challenge_method !== 'S256') return null;
  return { request_id: row.request_id, code_challenge: row.code_challenge, code_challenge_method: 'S256' };
}

export function createAccountPortalLoginProofPayload(
  proof: Omit<AccountPortalLoginProofV1, 'expiresAt' | 'issuedAt' | 'version'>,
  ttlSeconds: number,
  nowSeconds: number,
) {
  const accountId = safeAccountId(proof.accountId);
  const emailHash = safeEmailHash(proof.emailHash);
  const nonce = safeNonce(proof.nonce);
  const browserId = proof.browserId === undefined ? undefined : safeBrowserId(proof.browserId);
  const desktopHandoff = proof.desktopHandoff === undefined ? undefined : safeDesktopHandoff(proof.desktopHandoff);
  if (!accountId || !emailHash || !nonce || (proof.browserId !== undefined && !browserId)
    || (proof.desktopHandoff !== undefined && (!desktopHandoff || !browserId))) {
    throw new Error('Login proof is invalid.');
  }

  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Login proof TTL is invalid.');
  }

  return base64urlLoginProofJson({
    accountId,
    ...(browserId ? { browserId } : {}),
    ...(desktopHandoff ? { desktopHandoff } : {}),
    emailHash,
    expiresAt: nowSeconds + ttlSeconds,
    issuedAt: nowSeconds,
    nonce,
    returnPath: safeReturnPath(proof.returnPath),
    version: 1,
  });
}

export function readAccountPortalLoginProofPayload(
  payload: string | undefined,
  nowSeconds: number,
): AccountPortalLoginProofV1 | null {
  if (!payload) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const proof = parsed as Partial<AccountPortalLoginProofV1>;
  const accountId = safeAccountId(proof.accountId);
  const emailHash = safeEmailHash(proof.emailHash);
  const nonce = safeNonce(proof.nonce);
  const browserId = proof.browserId === undefined ? undefined : safeBrowserId(proof.browserId);
  const desktopHandoff = proof.desktopHandoff === undefined ? undefined : safeDesktopHandoff(proof.desktopHandoff);
  if (!accountId || !emailHash || !nonce || (proof.browserId !== undefined && !browserId)
    || (proof.desktopHandoff !== undefined && (!desktopHandoff || !browserId)) || proof.version !== 1) return null;
  if (
    typeof proof.expiresAt !== 'number' ||
    !Number.isFinite(proof.expiresAt) ||
    proof.expiresAt <= nowSeconds
  ) {
    return null;
  }
  if (typeof proof.issuedAt !== 'number' || !Number.isFinite(proof.issuedAt)) {
    return null;
  }

  return {
    accountId,
    ...(browserId ? { browserId } : {}),
    ...(desktopHandoff ? { desktopHandoff } : {}),
    emailHash,
    expiresAt: proof.expiresAt,
    issuedAt: proof.issuedAt,
    nonce,
    returnPath: safeReturnPath(proof.returnPath),
    version: 1,
  };
}
