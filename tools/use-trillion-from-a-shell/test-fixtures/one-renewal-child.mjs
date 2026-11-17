// A child process of trillion-one-renewal.test.mjs: one `trillion` run that needs a pass, against a test issuer and a sign-in kept in a file.
import { readFileSync, writeFileSync } from 'node:fs';
import settings from '../do-work/trillion.json' with { type: 'json' };
import { credentialFor } from '../do-work/trillion.mjs';

const [file, home] = process.argv.slice(2);
const grants = { where: file, read: () => JSON.parse(readFileSync(file, 'utf8')), write: grant => writeFileSync(file, JSON.stringify(grant)), forget() {} };
const credential = await credentialFor({ env: {}, store: { read: () => null }, grants, rules: { ...settings, state_folder: home }, home });
process.stdout.write(credential.bearer);
