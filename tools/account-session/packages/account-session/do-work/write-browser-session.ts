import {
  createAccountPortalSession,
  configuredSessionTtlSeconds,
  sessionCookieName,
  type AccountPortalSessionMinting,
} from '../read-data/session-token';

export type AccountPortalSessionCookie = {
  httpOnly: true;
  maxAge: number;
  name: string;
  path: '/';
  sameSite: 'lax';
  secure: boolean;
  value: string;
};

function accountSessionCookieSecure() {
  const configured = process.env.ACCOUNT_SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === '0' || configured === 'false' || configured === 'no' || configured === 'off') return false;
  return true;
}

export async function accountAccessSessionCookie(
  accountId: string,
  minting: AccountPortalSessionMinting,
): Promise<AccountPortalSessionCookie> {
  const issued = await createAccountPortalSession(accountId, minting);
  return accountAccessSessionCookieForToken(issued.token);
}

export function accountAccessSessionCookieForToken(
  token: string,
): AccountPortalSessionCookie {
  return {
    httpOnly: true,
    maxAge: configuredSessionTtlSeconds(),
    name: sessionCookieName(),
    path: '/',
    sameSite: 'lax',
    secure: accountSessionCookieSecure(),
    value: token,
  };
}

export async function issueAccountAccessSession(
  accountId: string,
  minting: AccountPortalSessionMinting,
) {
  const issued = await createAccountPortalSession(accountId, minting);
  return {
    cookie: accountAccessSessionCookieForToken(issued.token),
    session: issued.session,
  };
}

export function clearAccountPortalSessionCookie(): AccountPortalSessionCookie {
  return {
    httpOnly: true,
    maxAge: 0,
    name: sessionCookieName(),
    path: '/',
    sameSite: 'lax',
    secure: accountSessionCookieSecure(),
    value: '',
  };
}
