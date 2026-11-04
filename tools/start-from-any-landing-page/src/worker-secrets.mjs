// src/worker-secrets.mjs
//
// The one reader of the Worker's secrets. Every secret the Worker holds is a row of src/worker-secrets.json with the
// form its value must have; code asks `secret(env, name)` and gets the value, or null when it is not set. A secret
// set in another form is refused the first time it is read, by name and expected form, never by value, so a mistyped
// key fails loudly instead of quietly weakening what it protects (a phone index keyed by a short word, a root that is
// skipped). A name with no row is refused too, so a new secret is declared before anything reads it, and
// test/worker-secrets.test.mjs refuses any other module that reads a declared secret from `env` itself.
//
// Invariants:
// - A value never appears in an error, a log or an answer: only its name and the form it should have.
// - Every read checks the value as it is now, so a secret changed or removed is never answered from an earlier read.
import declared from './worker-secrets.json' with { type: 'json' };

const rows = new Map(declared.secrets.map(row => [row.name, declared.forms[row.form]]));
const fits = (form, value) => {
  if (form.json) { try { JSON.parse(value); return true; } catch { return false; } }
  return new RegExp(form.pattern).test(value);
};

/** The names of every secret the Worker may hold. */
export const SECRET_NAMES = [...rows.keys()];

/** The value of secret `name` in `env`, trimmed, or null when it is not set. Throws when it is set in another form. */
export function secret(env, name) {
  const form = rows.get(name);
  if (!form) throw new Error(`${name} is not a secret this Worker declares (src/worker-secrets.json).`);
  const raw = env?.[name];
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  if (value !== null && !fits(form, value)) throw new Error(`The secret ${name} is set, but not as ${form.says}.`);
  return value;
}
