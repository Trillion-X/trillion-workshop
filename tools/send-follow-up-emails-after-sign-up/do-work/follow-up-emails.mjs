// src/follow-up-emails.mjs
//
// Purpose
//   The emails that follow a sign-up while the person has bought nothing (src/follow-up-emails.json): day 1, 3, 7 and 14
//   after the account is made, each inviting them to the offer the DATA names, with its price and trial read from that
//   offer's row at send time. One per person store: creating an account never starts one (src/worker.mjs accountMade);
//   a sequence already started is woken by its alarm (src/scheduler.mjs, source `follow-up-emails`) when the next step
//   is due, and it sends through the one sender (src/mail-sender.mjs).
//
// Non-negotiable invariants
//   1. A step is sent at most once: it is marked sent before the email goes out, so a cut-off wake never sends it twice.
//   2. The sequence ends for good the moment the person holds any priced offer, or presses the stop link; nothing is
//      sent after either.
//   3. Nothing sold is written here or in the DATA: the offer's name, price and trial come from its row.
//   4. An account with no email gets none; a step whose time came while the account had none is skipped, not queued.
//   5. Every email carries the stop link, a one-click List-Unsubscribe header and the postal address.
//
// Content, offers, greeting words and postal address are current rows supplied by the host.
// Delivery uses tools/send-messages; person/account access remains a current host seam.
const DAY_MS = 86400000;
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (whole, name) => String(values[name] ?? whole));

const offerRow = (id, offerRecords) => offerRecords.records.find(row => row.id === id) ?? null;
const priced = offer => (offer?.price_options ?? []).some(option => option.amount_cents > 0);

/** Whether the person holds any offer with a price (a trial counts: they chose to buy). */
export const boughtSomething = (access, offerRecords) => (access?.active_offers ?? []).some(id => priced(offerRow(id, offerRecords)));

const money = (cents, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

/**
 * The words the offer gives (the one the free plan's upgrade line names, src/allowance.mjs upgradeOfferId): its name,
 * its free days, what it costs after, and the offer line and button in their trial or no-trial wording.
 */
export function offerWords(offerId, { settings, offerRecords }) {
  const offer = offerRow(offerId, offerRecords);
  const option = (offer?.price_options ?? []).find(row => row.amount_cents > 0);
  if (!option) throw new Error(`${offerId} has no price, so no email can invite anyone to it.`);
  const repeat = option.repeat ?? option;
  const values = {
    offer_id: offer.id, offer: offer.label, trial_days: option.trial_days ?? 0,
    then: `${money(repeat.amount_cents, option.currency)}${repeat.interval ? `/${repeat.interval}` : ''}`,
  };
  const wording = values.trial_days > 0 ? 'trial' : 'no_trial';
  return { ...values, offer_line: fill(settings.offer_line[wording], values), button: fill(settings.button[wording], values) };
}

/** One step's email as the one sender takes it: { subject, preheader, markdown, action, footer_lines, footer_links, headers }. */
export function stepEmail(step, { name = null, origin, stopUrl }, { settings, offerRecords, offerId, paidWorth, postalAddress }) {
  const values = { ...offerWords(offerId, { settings, offerRecords }), name: name ?? settings.no_name, paid_worth: paidWorth };
  return {
    subject: fill(step.subject, values), preheader: fill(step.preheader, values), markdown: fill(step.markdown, values),
    action: { label: values.button, href: `${origin}/buy/${encodeURIComponent(values.offer_id)}` },
    footer_lines: [settings.footer, postalAddress],
    footer_links: [{ label: settings.stop.label, href: stopUrl }],
    headers: { 'List-Unsubscribe': `<${stopUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

/**
 * One person's follow-ups, kept as one fact in their store: { user_id, started_at, token, sent: [step ids], ended_at, ended_by }.
 *   facts:  { read() → the kept value or null, write(value) }
 *   person: { email(userId) → the account's email or null, name(userId) → how to greet them or null,
 *             access() → their access, origin }
 *   send:   message → { sent, error? }   (src/mail-sender.mjs sendMail with the account's own email)
 */
export function makeFollowUps({ facts, person, send, settings, readOfferRecords, upgradeOfferId, paidWorth, postalAddress, now = () => Date.now(), random = bytes => crypto.getRandomValues(bytes) }) {
  const token = () => [...random(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const stopUrl = kept => `${person.origin}${settings.stop.path}?a=${encodeURIComponent(kept.user_id)}&t=${kept.token}`;
  const nextStep = kept => settings.steps.find(step => !kept.sent.includes(step.id)) ?? null;
  const end = (kept, by) => facts.write({ ...kept, ended_at: new Date(now()).toISOString(), ended_by: by }, kept);

  return {
    /** Starts the sequence when `userId`'s account is made; starting again changes nothing. */
    async start(userId) {
      const kept = await facts.read();
      if (kept) return kept;
      if (typeof userId !== 'string' || !userId) throw new Error('Follow-up emails start for an account id.');
      const started = { user_id: userId, started_at: new Date(now()).toISOString(), token: token(), sent: [], ended_at: null, ended_by: null };
      await facts.write(started, null);
      return started;
    },
    /** When the next step is due (epoch ms), or null when nothing is left to send. */
    async nextDue() {
      const kept = await facts.read();
      if (!kept || kept.ended_at) return null;
      const step = nextStep(kept);
      return step ? Date.parse(kept.started_at) + step.after_days * DAY_MS : null;
    },
    /**
     * Sends the newest step whose time has come; older ones whose time also passed (the alarm was late) are passed over
     * without sending, so a person never gets two at once. Ends the sequence when they bought or it ran out. → [{ step, sent }]
     */
    async sendDue() {
      const kept = await facts.read();
      if (!kept || kept.ended_at) return [];
      const left = settings.steps.filter(step => !kept.sent.includes(step.id));
      if (!left.length) { await end(kept, 'finished'); return []; }
      const due = left.filter(step => Date.parse(kept.started_at) + step.after_days * DAY_MS <= now());
      if (!due.length) return [];
      const offerRecords = await readOfferRecords();
      if (boughtSomething(await person.access(), offerRecords)) { await end(kept, 'bought'); return []; }
      const step = due.at(-1);
      const marked = { ...kept, sent: [...kept.sent, ...due.map(row => row.id)] };
      await facts.write(left.length === due.length ? { ...marked, ended_at: new Date(now()).toISOString(), ended_by: 'finished' } : marked, kept);
      const to = await person.email(kept.user_id);
      if (!to) return [{ step: step.id, sent: false, error: 'no email on the account' }];
      return [{ step: step.id, ...(await send({ to, ...stepEmail(step, { name: await person.name(kept.user_id), origin: person.origin, stopUrl: stopUrl(kept) }, { settings, offerRecords, offerId: await upgradeOfferId(), paidWorth: await paidWorth(), postalAddress: await postalAddress() }) })) }];
    },
    /** The stop link: ends the sequence when the token is this person's. → { stopped } */
    async stop(given) {
      const kept = await facts.read();
      if (!kept || typeof given !== 'string' || given !== kept.token) return { stopped: false };
      if (!kept.ended_at) await end(kept, 'stop-link');
      return { stopped: true };
    },
    read: () => facts.read(),
  };
}

/** Async facts over this run's records door. A competing wake or stop refuses
 * before delivery rather than overwriting the other one's claim. */
export function followUpFacts(door, { type, id }) {
  return {
    read: () => door.read(type, id),
    write: (value, previous) => door.write([{ type, id, value,
      expected: previous === null ? null : { type, value: previous } }]),
  };
}
