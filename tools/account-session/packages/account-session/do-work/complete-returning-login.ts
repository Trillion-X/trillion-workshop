import { readAccountAuthorityCanOpen } from '../read-data/read-account-authority-access';
import { readSignedAccountPortalLoginProofToken } from './login-proof-token-crypto';

export class ReturningLoginProofError extends Error {
  public readonly publicStatus = 400;
}

export class ReturningLoginAccountUnavailableError extends Error {
  public readonly publicStatus = 403;
}

export async function completeReturningLogin(
  token: string | null | undefined,
  nowSeconds: number,
) {
  const proof = await readSignedAccountPortalLoginProofToken(token ?? undefined, nowSeconds);
  if (!proof) {
    throw new ReturningLoginProofError('That sign-in link is expired or invalid.');
  }

  if (!(await readAccountAuthorityCanOpen(proof.accountId))) {
    throw new ReturningLoginAccountUnavailableError(
      'That account cannot open this app.',
    );
  }

  return {
    accountId: proof.accountId,
    browserId: proof.browserId,
    returnPath: proof.returnPath,
    ...(proof.desktopHandoff ? { desktopHandoff: proof.desktopHandoff } : {}),
  };
}
