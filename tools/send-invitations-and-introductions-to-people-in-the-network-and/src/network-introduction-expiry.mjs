// src/network-introduction-expiry.mjs
//
// A Network introduction request has a time to be answered: its answer time is when it was sent plus
// introduction_requests.answer_hours (src/network-settings.json). Its yes is given for the request as it was shown
// (src/consent-fingerprint.mjs). Mixed into the Network.
//
// Non-negotiable invariants
//   1. Past its answer time a request expires through the one lifecycle (src/introduction-states.mjs, sent -> expired),
//      stored by the Network's own alarm, so it ends with nobody's screen open; an answer after that time expires it
//      there and is refused, however late the alarm.
//   2. The asker never learns a decline: before the answer time anything not accepted reads as sent, and after it a
//      declined request reads as expired, the same as one nobody answered.
//   3. Only introductions: a request to join a space (membership_id) or a stay (stay_requests) keeps its own lifecycle.
//   4. An introduction is accepted only with the consent of what the asked person is shown of it now (requestShown): who
//      asks, why, what they offer, what accepting shares and the answer time. One that changed is refused naming what
//      changed, and the request stays sent.
import rules from '../../introduce-two-people/src/network-settings.json' with { type: 'json' };
import { introductionView, moveIntroduction } from '../../introduce-two-people/src/introduction-states.mjs';
import { consentOf, refuseChangedConsent } from './consent-fingerprint.mjs';

const HOUR = 3600000;
const settings = rules.introduction_requests;
const INTRODUCTION = "r.membership_id IS NULL AND NOT EXISTS (SELECT 1 FROM stay_requests s WHERE s.request_id = r.id)";
const answerTime = sentAt => Date.parse(sentAt) + settings.answer_hours * HOUR;
const isIntroduction = (host, request) => !request.membership_id && !host.sql.exec('SELECT 1 FROM stay_requests WHERE request_id = ? LIMIT 1', request.id).toArray().length;

export const introductionExpiryMethods = {
  setUpIntroductionExpiry() {
    this.sql.exec('CREATE INDEX IF NOT EXISTS requests_by_status ON requests (status, created_at)');
  },

  // When the alarm next has an introduction to expire: the oldest one still waiting, at its answer time.
  nextIntroductionExpiryAt() {
    const oldest = this.sql.exec(`SELECT r.created_at FROM requests r WHERE r.status = 'sent' AND ${INTRODUCTION} ORDER BY r.created_at LIMIT 1`).toArray()[0];
    return oldest ? answerTime(oldest.created_at) : null;
  },

  // Every introduction whose answer time has come, one page a wake, stored as expired.
  async expireDueIntroductions(now = Date.now()) {
    const cutoff = new Date(now - settings.answer_hours * HOUR).toISOString();
    const due = this.sql.exec(`SELECT r.id, r.status FROM requests r WHERE r.status = 'sent' AND r.created_at <= ? AND ${INTRODUCTION} ORDER BY r.created_at LIMIT ?`, cutoff, settings.page).toArray();
    const at = new Date(now).toISOString();
    for (const row of due) this.sql.exec("UPDATE requests SET status = ?, answered_at = ? WHERE id = ? AND status = 'sent'", moveIntroduction(row.status, 'expired'), at, row.id);
    return due.length;
  },

  // Called before an answer is taken: a request past its answer time is expired now and the answer refused.
  refuseExpiredAnswer(request, now = Date.now()) {
    if (request.status !== 'sent' || !isIntroduction(this, request) || answerTime(request.created_at) > now) return;
    this.sql.exec("UPDATE requests SET status = ?, answered_at = ? WHERE id = ? AND status = 'sent'", moveIntroduction(request.status, 'expired'), new Date(now).toISOString(), request.id);
    throw Object.assign(new Error(settings.words.ended), { status: 409 });
  },

  // What the asked person is shown of an introduction request, the parts their yes is given for (invariant 4).
  requestShown(request) {
    const offering = this.sql.exec('SELECT offering FROM listings WHERE relay = ? LIMIT 1', request.from_relay).toArray()[0]?.offering ?? null;
    return { text: { why: request.why, offering }, recipients: [request.from_relay], shared: settings.shares, expires_at: new Date(answerTime(request.created_at)).toISOString() };
  },
  // The consent shown beside a request waiting for its answer: an introduction's, none for a space or a stay request.
  requestConsent(request) {
    return isIntroduction(this, request) ? consentOf(this.requestShown(request)) : null;
  },
  // Called before an introduction is accepted: refused unless the yes was given for it as it is shown now.
  refuseChangedRequest(request, consent) {
    if (isIntroduction(this, request)) refuseChangedConsent(consent, this.requestShown(request), settings.words.changed);
  },

  // What the asker reads of a request they sent (invariant 2).
  askerSees(request, now = Date.now()) {
    if (request.status === 'accepted') return introductionView('accepted');
    const ended = request.status === 'expired' || (request.status === 'declined' && isIntroduction(this, request) && answerTime(request.created_at) <= now);
    return introductionView(ended ? 'expired' : 'sent');
  },
};
