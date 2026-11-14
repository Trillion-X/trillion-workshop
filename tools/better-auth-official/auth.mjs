// Better Auth, set up as its docs show (https://www.better-auth.com/docs): the built-in node:sqlite database, email and password,
// passkey, two factor, email OTP, magic link, multi session, API keys, JWT (EdDSA), MCP (the OAuth 2.1 provider for MCP clients,
// with Client ID Metadata Documents), device authorization and bearer (which the device docs require to use its session token). Everything that differs per place is DATA in settings.json,
// read from BETTER_AUTH_SETTINGS (default ./settings.json); the secret comes from BETTER_AUTH_SECRET.

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import {
  bearer, deviceAuthorization, emailOTP, jwt, magicLink, multiSession, twoFactor,
} from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { emailHook } from './send-email.mjs';
import { cookieOptions } from './cookie-options.mjs';
import { trustedOriginsFor } from './attached-origins.mjs';

const settingsPath = resolve(process.env.BETTER_AUTH_SETTINGS ?? new URL('./settings.json', import.meta.url).pathname);
export const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const here = dirname(settingsPath);
const databasePath = resolve(here, settings.database_path);
mkdirSync(dirname(databasePath), { recursive: true });
const sendEmail = emailHook({ ...settings.email, outbox: resolve(here, settings.email.outbox) });

export const auth = betterAuth({
  baseURL: settings.base_url,
  basePath: settings.base_path,
  database: new DatabaseSync(databasePath),
  // The home origins, and every verified attached origin at request time (attached-origins.mjs).
  trustedOrigins: trustedOriginsFor(settings),
  disabledPaths: settings.disabled_paths,
  advanced: cookieOptions(settings),
  emailAndPassword: {
    enabled: true,
    sendResetPassword: async ({ user, url, token }) => {
      void sendEmail({ kind: 'reset-password', to: user.email, url, token });
    },
  },
  plugins: [
    // No fixed `origin`: the passkey plugin then expects the base URL's origin, and an attached origin when trustedOrigins
    // names it (its related origins, /.well-known/webauthn), as its docs say.
    passkey({ rpID: settings.passkey.rp_id, rpName: settings.passkey.rp_name }),
    twoFactor({ issuer: settings.two_factor_issuer }),
    emailOTP({
      async sendVerificationOTP({ email, otp, type }) {
        void sendEmail({ kind: `otp-${type}`, to: email, otp });
      },
    }),
    magicLink({
      sendMagicLink: async ({ email, token, url }) => {
        void sendEmail({ kind: 'magic-link', to: email, url, token });
      },
    }),
    multiSession(),
    apiKey(),
    jwt({
      disableSettingJwtHeader: settings.disabled_paths.includes('/token'),
      jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
      jwt: { issuer: settings.issuer, audience: settings.audience },
    }),
    mcp({
      loginPage: settings.mcp.login_page,
      consentPage: settings.mcp.consent_page,
      resource: settings.mcp.resource,
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    deviceAuthorization({ verificationUri: settings.device.verification_uri }),
    bearer(),
  ],
});
