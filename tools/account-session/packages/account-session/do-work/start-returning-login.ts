import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import { readMaterializedRoleValue } from '../../../../shared-code/packages/account-identity/read-data/account-identity-materialization';
import {
  accountAccessPublicUrl,
  AccountAuthorityAccessUnavailableError,
  readAccountAuthorityCanOpen,
} from '../read-data/read-account-authority-access';
import {
  safeReturnPath,
} from '../read-data/login-proof-token';
import { createSignedAccountPortalLoginProofToken } from './login-proof-token-crypto';
import { sendResendEmail } from '../../resend-email-sender/do-work/send-resend-email';

export type StartReturningLoginInput = {
  allowedPublicOrigin?: unknown;
  browserId?: unknown;
  email: unknown;
  emailMessage?: unknown;
  requestId?: string | null;
  returnPath?: unknown;
  publicUrl?: unknown;
  desktopHandoff?: import('../read-data/login-proof-token').AccountPortalLoginProofV1['desktopHandoff'];
};

export type StartReturningLoginReceipt = {
  accepted: true;
};

type ReturningLoginIdentity = {
  subject: string;
  email: string;
  emailProof: string;
};

const ACCOUNT_IDENTITY_TARGET = 'account-identity.derive';

export function accountLoginPublicUrl(value: unknown, allowedPublicOrigin?: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    // A caller that names no return URL gets the origin this deployment
    // declares for itself. Reading the environment first put the hosting
    // provider's own hostname into sign-in emails, so the link arrived
    // pointing at the machine rather than at the address the person typed,
    // even though the declared origin beside it was correct.
    if (typeof allowedPublicOrigin === 'string' && allowedPublicOrigin.trim()) {
      return new URL(new URL(allowedPublicOrigin).origin);
    }
    return accountAccessPublicUrl();
  }
  const url = new URL(value);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  const allowedLoopback = loopback && url.protocol === 'http:';
  // D1 FINAL-CLOSE: the configured-origin comparison is LAZY. A desktop shell
  // legitimately runs with no ACCOUNT_PUBLIC_URL (its return origin is the
  // loopback shell itself); eagerly reading the env here threw
  // 'ACCOUNT_PUBLIC_URL is not configured.' for a perfectly allowed loopback
  // return URL, which is exactly the local sign-in send failure. Only a
  // NON-loopback origin needs the configured origin to compare against.
  if (!allowedLoopback) {
    const configured = typeof allowedPublicOrigin === 'string' && allowedPublicOrigin.trim()
      ? new URL(allowedPublicOrigin)
      : accountAccessPublicUrl();
    if (configured.username || configured.password || configured.origin !== configured.toString().replace(/\/$/, '')) {
      throw new Error('The configured account origin is not allowed.');
    }
    const configuredOrigin = configured.origin;
    if (url.origin !== configuredOrigin || url.username || url.password) {
      throw new Error('The requested account return URL is not an allowed account origin.');
    }
  } else if (url.username || url.password) {
    throw new Error('The requested account return URL is not an allowed account origin.');
  }
  return new URL(url.origin);
}

function loginProofLink(token: string, publicUrl: unknown, allowedPublicOrigin?: unknown) {
  const url = new URL('/account', accountLoginPublicUrl(publicUrl, allowedPublicOrigin));
  url.searchParams.set('account_login', 'complete');
  url.searchParams.set('token', token);
  return url.toString();
}

async function canDeliverReturningLogin(subject: string) {
  try {
    return await readAccountAuthorityCanOpen(subject);
  } catch (error) {
    if (error instanceof AccountAuthorityAccessUnavailableError && error.status === 404) {
      return false;
    }
    throw error;
  }
}

export function readReturningLoginIdentityReply(payload: Uint8Array): ReturningLoginIdentity {
  return {
    subject: readMaterializedRoleValue(payload, 'identity.subject'),
    email: readMaterializedRoleValue(payload, 'identity.input.normalized'),
    emailProof: readMaterializedRoleValue(payload, 'identity.proof.email'),
  };
}

async function deriveReturningLoginIdentity(email: unknown) {
  const reply = await sendRequestToBitfieldTarget({
    target: ACCOUNT_IDENTITY_TARGET,
    payload: { email },
  });
  return readReturningLoginIdentityReply(reply.payload);
}

async function requestLoginLinkDelivery(input: {
  email: string;
  link: string;
  message?: Record<string, unknown>;
  requestId?: string | null;
}) {
  await sendResendEmail({
    template: 'account-login-link',
    to: input.email,
    idempotencyKey: input.requestId ?? undefined,
    variables: { link: input.link },
    message: input.message ?? {
      from: 'Bitfield <owner@example.com>',
      subject: 'Your Bitfield sign-in link',
      html_template: [
        '<p>Use this link to sign in to your Bitfield account:</p>',
        '<p><a href="{{link}}">Sign in</a></p>',
        '<p>If you did not request this, you can ignore this email.</p>',
      ],
      text_template: [
        'Use this link to sign in to your Bitfield account:',
        '',
        '{{link}}',
        '',
        'If you did not request this, you can ignore this email.',
      ],
    },
  });
}

/** The clock and the nonce identity are runtime facts the target reads from its context. */
export type StartReturningLoginMinting = {
  mintId: () => string;
  nowSeconds: number;
};

export async function startReturningLogin(
  input: StartReturningLoginInput,
  minting: StartReturningLoginMinting,
): Promise<StartReturningLoginReceipt> {
  const identity = await deriveReturningLoginIdentity(input.email);
  const accountId = identity.subject;
  if (!(await canDeliverReturningLogin(accountId))) {
    return { accepted: true };
  }

  const token = await createSignedAccountPortalLoginProofToken({
    accountId,
    ...(typeof input.browserId === 'string' ? { browserId: input.browserId } : {}),
    ...(input.desktopHandoff ? { desktopHandoff: input.desktopHandoff } : {}),
    emailHash: identity.emailProof,
    nonce: minting.mintId(),
    returnPath: safeReturnPath(input.returnPath),
  }, minting.nowSeconds);
  await requestLoginLinkDelivery({
    email: identity.email,
    link: loginProofLink(token, input.publicUrl, input.allowedPublicOrigin),
    ...(
      input.emailMessage && typeof input.emailMessage === 'object' && !Array.isArray(input.emailMessage)
        ? { message: input.emailMessage as Record<string, unknown> }
        : {}
    ),
    requestId: input.requestId ?? null,
  });

  return { accepted: true };
}
