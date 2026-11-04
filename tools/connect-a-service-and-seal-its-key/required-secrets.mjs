// src/required-secrets.mjs
//
// Purpose: a deploy does not go live without the secrets src/worker-secrets.json marks required (the two key-derivation roots,
// F-1144): without them the Worker would quietly store the keys it should derive. The names bound on the Worker are read through
// wrangler; a security precondition fails closed, so a list that cannot be read is tried again (3 attempts, backing off) and then
// refuses the deploy naming the failure, rather than letting a missing secret ship because one call flaked.
import declared from './worker-secrets.json' with { type: 'json' };

export const REQUIRED_CHECK_MODE = declared.required_check === 'enforce' ? 'enforce' : 'report';
export const REQUIRED_SECRETS = declared.secrets.filter(row => row.required === true).map(row => row.name);
/** The required secret names not in `bound` (names only). */
export const requiredSecretsMissing = (bound, required = REQUIRED_SECRETS) => required.filter(name => !bound.includes(name));

/** The names bound on the Worker: `list()` answers wrangler's JSON text (or throws or answers null on a failed call). */
export async function boundSecretNames(list, { attempts = 3, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), backoffMs = 2000 } = {}) {
  let last = 'no answer';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const text = await list();
      if (typeof text === 'string') {
        const rows = JSON.parse(text);
        if (Array.isArray(rows)) return rows.map(row => row?.name).filter(name => typeof name === 'string');
        last = 'not a list';
      } else last = 'wrangler answered nothing';
    } catch (error) { last = String(error?.message ?? error).slice(0, 200); }
    if (attempt < attempts) await wait(backoffMs * attempt);
  }
  throw new Error(`the secrets bound on the Worker could not be read after ${attempts} attempts (${last})`);
}

/** What the deploy says and does about the required secrets: { line, block }. In report mode it never blocks. */
export async function requiredSecretsVerdict(list, { mode = REQUIRED_CHECK_MODE, ...options } = {}) {
  let bound;
  try { bound = await boundSecretNames(list, options); }
  catch (error) { return { line: `required secrets: could not list: ${error.message}`, block: mode === 'enforce' }; }
  const missing = requiredSecretsMissing(bound);
  return missing.length ? { line: `required secrets: MISSING ${missing.join(', ')}`, block: mode === 'enforce' } : { line: 'required secrets: OK', block: false };
}
