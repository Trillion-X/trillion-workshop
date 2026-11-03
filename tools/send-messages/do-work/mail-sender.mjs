// Every email to one address is written down under that address (APP_KV `sent_log.key_prefix` + the BLAKE3 identity of
// the lowercased address): when, what kind, and its subject unless its kind keeps the subject out (a sign-in code's
// subject carries the code). The rows of `per_person.limits` are counted against that list. Reading the list back is
// how every email one person was sent is listed.
const blake3Hex = text => bytesToHex(blake3(new TextEncoder().encode(text)));
const sentKey = to => `${settings.sent_log.key_prefix}${blake3Hex(String(to).trim().toLowerCase())}`;
const limitCovers = (limit, kind) => (limit.kinds ? limit.kinds.includes(kind) : !(limit.all_kinds_except ?? []).includes(kind));
const mailPool = env => env?.POOL ? hostOf(env, { kind: 'pool', key: 'everyone' }) : null;
const legacySentTo = async (env, to, now) => {
  const kept = await env?.APP_KV?.get(sentKey(to));
  return (kept ? JSON.parse(kept) : []).filter(row => now - Date.parse(row.at) < settings.sent_log.days * 86_400_000);
};

/** The emails sent to `to` within the log's days, oldest first: [{ at, kind, subject? }]. */
export async function sentTo(env, to, now = Date.now()) {
  const legacy = await legacySentTo(env, to, now);
  return env?.POOL ? mailPool(env).mailSentTo(sentKey(to), now, legacy) : legacy;
}

/** The `per_person` limit a send of `kind` to someone already sent `sent` would go over, or null. */
export function limitReached(sent, kind, now = Date.now()) {
  return settings.per_person.limits.find(limit => limitCovers(limit, kind)
    && sent.filter(row => limitCovers(limit, row.kind) && now - Date.parse(row.at) < limit.window_minutes * 60_000).length >= limit.most) ?? null;
}

// A proof account's own address: every recipient matches a pattern of src/proof-account-names.json.
const PROOF_NAMES = proofNames.patterns.map(pattern => new RegExp(pattern, 'i'));
const addressOf = to => String(typeof to === 'object' && to !== null ? to.email ?? '' : to).trim().toLowerCase();
export const isProofAddress = to => [to].flat().length > 0 && [to].flat().every(each => PROOF_NAMES.some(pattern => pattern.test(addressOf(each))));

// A proof's mail, never handed to the sending binding: to a `handed_on` proof inbox (src/inbound-mail-settings.json) it
// is handed straight to that inbox's keeper as the round trip would have handed it, its words as one plain-text part.
async function keepForProof(env, composed) {
  const to = addressOf([composed.to].flat()[0]);
  const keeper = env?.[handedOnFor(to)?.binding];
  if (!keeper?.keep) return { sent: true, id: null, kept_for_proof: settings.held_for_proofs.not_kept };
  const from = addressOf(composed.from);
  const raw = [`From: ${from}`, `To: ${to}`, `Subject: ${composed.subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', composed.text ?? ''].join('\r\n');
  await keeper.keep({ from, to, subject: composed.subject, raw });
  return { sent: true, id: null, kept_for_proof: settings.held_for_proofs.kept_in_inbox };
}

// How many emails the binding has taken today (UTC), kept under `daily.key_prefix` + the day.
const dayKey = now => `${settings.daily.key_prefix}${new Date(now).toISOString().slice(0, 10)}`;
const sentToday = async (env, now) => Number(await env?.APP_KV?.get(dayKey(now))) || 0;
const countToday = (env, now, count) => env?.APP_KV?.put(dayKey(now), String(count), { expirationTtl: 2 * 86_400 });

// The production binding's single SQL owner reserves recipient and day limits together, before any delivery.
// A refused admission or unreachable owner cannot fall through to KV dispatch. KV rows seed each SQL identity once.
async function admittedDelivery(env, binding, composed, kind, now) {
  const proof = isProofAddress(composed.to);
  const addresses = [...new Set([composed.to].flat().map(addressOf))];
  const recipients = addresses.map(sentKey);
  let pool, admission;
  try {
    pool = mailPool(env);
    const legacy = Object.fromEntries(await Promise.all(addresses.map(async address => [sentKey(address), await legacySentTo(env, address, now)])));
    admission = await pool.reserveMail({ id: crypto.randomUUID(), recipients, kind, subject: composed.subject, proof, now, legacy,
      legacyDay: proof ? 0 : await sentToday(env, now) });
  } catch (error) {
    console.error('email allowance unavailable:', error?.message ?? '');
    return { sent: false, error: 'Email could not be sent while its sending limit is unavailable. Try again shortly.' };
  }
  if (!admission.allowed) return { sent: false, limited: true, error: admission.error };
  const settle = async (state, full = false) => {
    try { await pool.settleMail(admission.id, state, full); }
    catch (error) { console.error('email result could not be kept; its allowance remains held:', error?.message ?? ''); }
  };
  let result;
  try { result = proof ? await keepForProof(env, composed) : await binding.send(composed); }
  catch (error) {
    const refused = !proof && settings.refused_before_dispatch_codes.codes.includes(error.code);
    await settle(refused ? 'released' : 'unknown', error.code === settings.daily.provider_full_code);
    return { sent: false, ...(!refused ? { unknown: true } : {}), ...(settings.refused_before_dispatch_codes.suppression_codes.includes(error.code) ? { suppressed: true } : {}), error: `${error.code ?? 'send-failed'}: ${error.message ?? ''}`.slice(0, 200) };
  }
  await settle('sent');
  return proof ? result : { sent: true, id: result?.messageId ?? null };
}

// Hands one composed message to the sending binding: { sent: true, id }, { sent: false, error }, { sent: false,
// limited: true, error } when it would go over a per-person limit for its `kind` or over the day's share for kinds the
// day does not keep room for, { sent: false, refused: true, error } for an address this Worker's own mail handler
// would turn away (src/inbound-mail-addresses.mjs refusalOf), which is never handed to the binding, or
// { sent: false, unknown: true, error } when the binding threw with a code not in refused_before_dispatch_codes (it may
// have sent). A proof's own address is answered { sent: true, id: null, kept_for_proof } without the binding.
async function deliver(env, composed, kind = settings.per_person.default_kind) {
  const binding = env?.[settings.send_binding];
  if (!binding?.send) return { sent: false, error: `no email-sending binding is bound as ${settings.send_binding}` };
  const refused = await refusalOf(env, composed.to);
