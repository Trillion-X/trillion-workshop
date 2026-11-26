// tools/send-messages/read-data/email-course.mjs
//
// Who agreed to get which emails. Generic public email-course owner. The host supplies DATA; capture-only mode
// stores one-update consent without sending, while enrolled lessons use the contact, send and lesson-schedule targets
// the caller hands in (do-work/keep-who-agreed.mjs gives them from the person's records and the sending tool).
//
// Every enrollment records its basis, the one reason it may be sent to: { kind: consent, text } (the person agreed in the
// words of course.consent_text) or { kind: transaction, source_row } (a purchase or other transaction the caller names by
// its row). The same rules hold for every course and whoever enrolls. A course may also say:
//   waits             each send waits on a yes from the caller: waits_until, true or false, given on every wake for that
//                     enrollment (by its enrollment_key); never assumed
//   late_after_hours  a lesson more than this many hours past its time is not sent; it is held as an email-course-held row
//   retry_failed      false: a failed send is not queued again
//   stop_scope        the stop a person's link makes covers every course of this scope (default: the course itself)
//   reply_to          the plain address a reply goes to
// A lesson with no html_lines is sent as text only. An enrollment may carry its own variables ({ name: text }), filled into
// its lessons' subject and words beside the engine's own (articleUrl, checkoutUrl, unsubscribeUrl, mailingAddress), which
// they never replace.
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';
import defaults from './email-course.json' with { type: 'json' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^[A-Za-z0-9_-]{32,100}$/;
const COURSE_ID = /^[a-z0-9][a-z0-9-]{2,80}$/;
const MOST_KEY_LENGTH = 300;
const encoder = new TextEncoder();

function digest(value) {
  return makeHashCodeHexFromBytes(encoder.encode(value)).slice('1f:'.length);
}

function expectedCurrent(reply) {
  if (!reply?.found) return { content_hash: null };
  if (!/^1f:[a-f0-9]{64}$/.test(reply.content_hash ?? '')) throw new Error('Subscription state could not be verified.');
  return { content_hash: reply.content_hash };
}

function currentPayload(reply) {
  if (!reply?.found) return null;
  if (Object.hasOwn(reply, 'payload')) return reply.payload;
  if (typeof reply.payload_base64 === 'string') return JSON.parse(Buffer.from(reply.payload_base64, 'base64').toString('utf8'));
  throw new Error('Subscription state has no readable contents.');
}

// One enrollment per course and key: the caller's enrollment_key (one per purchase, say), else the contact's account.
function subscriptionAddress(courseId, accountId, enrollmentKey) {
  return `email-course.subscription::${digest(JSON.stringify(enrollmentKey === undefined ? [courseId, accountId] : [courseId, 'key', enrollmentKey]))}`;
}

function interestAddress(courseId, email) {
  return `email-course.interest::${digest(JSON.stringify([courseId, email]))}`;
}

function tokenAddress(token) {
  return `email-course.token::${digest(token)}`;
}

function stopAddress(scope, accountId) {
  return `email-course.stop::${digest(JSON.stringify([scope, accountId]))}`;
}

function heldAddress(subscription, index) {
  return `email-course.held::${digest(JSON.stringify([subscription, index]))}`;
}

/** The scope a stop link covers: the course's stop_scope, else the course itself. */
export function stopScopeOf(course) {
  return course.stop_scope ?? course.id;
}

const keyText = value => typeof value === 'string' && value.trim() !== '' && value.length <= MOST_KEY_LENGTH;
const ENGINE_VARIABLES = new Set(['articleUrl', 'checkoutUrl', 'unsubscribeUrl', 'mailingAddress']);
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

// An enrollment's own variables, as they are kept: at most 20, each a name and a text of at most 2000 characters.
function variablesOf(variables) {
  if (variables === undefined) return {};
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new Error('An enrollment\'s variables are { name: text }.');
  const entries = Object.entries(variables);
  if (entries.length > 20 || entries.some(([name, value]) => !VARIABLE_NAME.test(name) || ENGINE_VARIABLES.has(name) || typeof value !== 'string' || value.length > 2000)) {
    throw new Error(`An enrollment's variables are at most 20 names (letters, digits, _; not ${[...ENGINE_VARIABLES].join(', ')}), each a text of at most 2000 characters.`);
  }
  return Object.fromEntries(entries);
}

// The pure rules of a course. No I/O: createPublicEmailCourse calls them, and so can any program that keeps its own sent log
// (workshop/tools/send-messages/read-data/email-course.mjs), so each rule has one owner. A step's key names it in the sent log.
export const HOUR_MS = 3_600_000;

// The subscription is still owed its steps.
export function isActive(enrollment) {
  return enrollment?.status === 'active';
}

// The step with this key is already in the sent log.
export function alreadySent(sent, key) {
  return Boolean(sent?.[key]);
}

// The step's time has come: startedAt (epoch milliseconds) plus its delay_hours is at or before now (a Date).
export function isDue(startedAt, step, now) {
  return startedAt + step.delay_hours * HOUR_MS <= now.getTime();
}

// The step is more than lateAfterHours past its time (never, when the course gives no lateAfterHours).
export function isLate(startedAt, step, now, lateAfterHours) {
  return lateAfterHours !== undefined && startedAt + (step.delay_hours + lateAfterHours) * HOUR_MS < now.getTime();
}

// The step owed now, or null. Steps go in order, so a step not yet due holds back the later ones. A step that is not a receipt
// is held while the enrollment is not active; a receipt is not held by that.
export function dueStep(enrollment, steps, now) {
  for (const step of steps) {
    if (alreadySent(enrollment.sent, step.key)) continue;
    if (!isDue(enrollment.started_at, step, now)) return null;
    if (!step.receipt && !isActive(enrollment)) return null;
    return step;
  }
  return null;
}

function assertCourse(course) {
  if (course?.capture_only === true) throw new Error('Email lessons are not ready to send.');
  if (!course || typeof course !== 'object' || !COURSE_ID.test(course.id ?? '')) throw new Error('Email course is unavailable.');
  const origin = new URL(course.public_origin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Email course origin is invalid.');
  if (!Array.isArray(course.lessons) || course.lessons.length < 1 || course.lessons.length > 12) throw new Error('Email course has no valid lessons.');
  let previous = -1;
  for (const lesson of course.lessons) {
    if (!Number.isInteger(lesson.delay_hours) || lesson.delay_hours <= previous || lesson.delay_hours > 24 * 29) throw new Error('Email course lesson timing is invalid.');
    previous = lesson.delay_hours;
    if (lesson.receipt !== undefined && typeof lesson.receipt !== 'boolean') throw new Error('Email course lesson receipt flag is invalid.');
    const copies = lesson.html_lines === undefined ? [lesson.text_lines] : [lesson.text_lines, lesson.html_lines];
    if (typeof lesson.subject !== 'string' || !lesson.subject.trim()
      || !copies.every(lines => Array.isArray(lines) && lines.every((line) => typeof line === 'string'))
      || (lesson.receipt !== true && !copies.every(lines => lines.join('\n').includes('{unsubscribeUrl}') && lines.join('\n').includes('{mailingAddress}')))) {
      throw new Error('Email course lesson copy is incomplete.');
    }
    const article = new URL(lesson.article_url, origin);
    if (article.origin !== origin.origin) throw new Error('Email course lesson link is outside this site.');
  }
  // The stop page a lesson links to: the course's own (stop_path), else the default; one {token}, on this site.
  const stopPath = course.stop_path ?? defaults.stop_path;
  if (typeof stopPath !== 'string' || stopPath.split('{token}').length !== 2
    || new URL(stopPath.replace('{token}', 'token'), origin).origin !== origin.origin) throw new Error('Email course stop link is invalid or outside this site.');
  if (course.checkout_url !== undefined && (typeof course.checkout_url !== 'string' || !course.checkout_url.trim()
    || new URL(course.checkout_url, origin).origin !== origin.origin)) throw new Error('Email course checkout link is outside this site.');
  if (course.lessons[0].delay_hours !== 0 || typeof course.from !== 'string' || !course.from.trim()
    || typeof course.mailing_address !== 'string' || !course.mailing_address.trim()) throw new Error('Email course consent or sender is incomplete.');
  if (course.waits !== undefined && typeof course.waits !== 'boolean') throw new Error('Email course waits is true or false.');
  if (course.retry_failed !== undefined && typeof course.retry_failed !== 'boolean') throw new Error('Email course retry_failed is true or false.');
  if (course.late_after_hours !== undefined && (!Number.isInteger(course.late_after_hours) || course.late_after_hours < 1 || course.late_after_hours > 24 * 29)) {
    throw new Error('Email course late_after_hours is a whole number of hours, 1 or more.');
  }
  if (course.stop_scope !== undefined && !COURSE_ID.test(course.stop_scope)) throw new Error('Email course stop_scope is invalid.');
  if (course.reply_to !== undefined && (typeof course.reply_to !== 'string' || !EMAIL.test(course.reply_to) || /[\s<>,;]/.test(course.reply_to))) {
    throw new Error('Email course reply_to is one plain email address.');
  }
  return origin;
}

// The enrollment's basis as it is kept: the person's consent in the course's own words, or the transaction's row (and, when
// given, the time of the transaction, from which the lessons are timed; never later than now).
function basisOf(basis, course, now) {
  if (basis?.kind === 'consent') {
    if (typeof course.consent_text !== 'string' || !course.consent_text.trim()) throw new Error('Email course consent or sender is incomplete.');
    if (basis.text !== course.consent_text) throw new Error('Please agree to receive the email lessons.');
    return { kind: 'consent', text: basis.text };
  }
  if (basis?.kind === 'transaction') {
    if (!keyText(basis.source_row)) throw new Error('A transaction basis names the transaction\'s row (source_row).');
    if (basis.at !== undefined && (typeof basis.at !== 'string' || !Number.isFinite(Date.parse(basis.at)) || Date.parse(basis.at) > now.getTime())) {
      throw new Error('A transaction basis\'s at is the time of the transaction, not later than now.');
    }
    return { kind: 'transaction', source_row: basis.source_row, ...(basis.at === undefined ? {} : { at: new Date(Date.parse(basis.at)).toISOString() }) };
  }
  throw new Error('Please agree to receive the email lessons, or name the transaction they come with.');
}

/** The stop (unsubscribe) link of one person's lessons: the course's stop_path (else the default) under its public_origin. */
export function stopUrl(course, token) {
  return new URL((course.stop_path ?? defaults.stop_path).replace('{token}', encodeURIComponent(token)), course.public_origin).href;
}

function messageFor(course, lesson) {
  return {
    from: course.from,
    subject: lesson.subject,
    text_template: lesson.text_lines,
    // An empty html_template overrides the sending template's own: a text-only lesson is sent with no html part.
    html_template: lesson.html_lines ?? [],
  };
}

// The lesson that falls due at a time: the seam keeps it as a record, and send-due-email-lessons delivers it once it is due.
function lessonDue(state, index, retry = 0) {
  const lesson = state.course.lessons[index];
  const scheduledAt = new Date(Date.parse(state.started_at) + lesson.delay_hours * HOUR_MS + (retry ? 2 ** retry * HOUR_MS : 0)).toISOString();
  const recordId = `email-course:${digest(state.subscription_address)}:${index}:${retry}`;
  return {
    record_id: recordId, due_at: scheduledAt, course_id: state.course.id, lesson_index: index, retry,
    token: state.unsubscribe_token, owner_ref: state.subscription_address,
    ...(state.enrollment_key === undefined ? {} : { enrollment_key: state.enrollment_key }),
  };
}

export function createPublicEmailCourse({ readCurrent, writeBatch, invokeTarget, now, mintToken }) {
  if (typeof now !== 'function' || typeof mintToken !== 'function') throw new Error('Email course requires trusted clock and entropy owners.');
  async function persist(writes) {
    const reply = await writeBatch(writes);
    if (reply?.ok === false || reply?.success === false || reply?.status === 'failed' || reply?.error) {
      throw new Error('Email course state could not be saved.');
    }
  }
  async function schedule(state, index, retry = 0) {
    const reply = await invokeTarget('lesson.schedule', lessonDue(state, index, retry));
    if (reply?.status !== 'scheduled') throw new Error('Follow-up lesson could not be scheduled.');
  }
  async function stopped(state) {
    return (await readCurrent(stopAddress(stopScopeOf(state.course), state.account_id)))?.found === true;
  }
  // A late lesson is not sent: it is kept once as a held row the person can read, and nothing more is done with it here.
  async function holdLate(state, index) {
    const address = heldAddress(state.subscription_address, index);
    const current = await readCurrent(address);
    if (!current?.found) {
      const lesson = state.course.lessons[index];
      await persist([{ address_label: address, expected_current: { content_hash: null }, path_labels: ['email-course', 'email-course-held'], payload: {
        kind: 'email-course-held', why: 'late', course_id: state.course.id, subscription_address: state.subscription_address,
        ...(state.enrollment_key === undefined ? {} : { enrollment_key: state.enrollment_key }), lesson_index: index,
        due_at: new Date(Date.parse(state.started_at) + lesson.delay_hours * HOUR_MS).toISOString(),
        late_after_hours: state.course.late_after_hours, held_at: now().toISOString(),
      } }]);
    }
    return { status: 'held-late', lesson_index: index };
  }

  async function deliver({ token, lesson_index: index, retry = 0, waits_until: waitsUntil }) {
    if (typeof token !== 'string' || !TOKEN.test(token) || !Number.isInteger(index) || index < 0
      || !Number.isInteger(retry) || retry < 0 || retry > 3) throw new Error('Invalid lesson request.');
    const tokenState = currentPayload(await readCurrent(tokenAddress(token)));
    if (!tokenState?.subscription_address) throw new Error('Lesson subscription was not found.');
    const address = tokenState.subscription_address;
    const before = await readCurrent(address);
    const state = currentPayload(before);
    if (!state || state.unsubscribe_token !== token) throw new Error('Lesson subscription changed.');
    if (!isActive(state) || await stopped(state)) return { status: 'unsubscribed' };
    const lesson = state.course.lessons[index];
    if (!lesson) throw new Error('Lesson does not exist.');
    if (state.waits === true) {
      // No answer is not a yes: nothing is sent, and the caller is told it gave none.
      if (typeof waitsUntil !== 'boolean') return { status: 'no-waits-answer', lesson_index: index };
      if (!waitsUntil) return { status: 'waiting', lesson_index: index };
    }
    const startedAt = Date.parse(state.started_at);
    if (!isDue(startedAt, lesson, now())) return { status: 'not-due' };
    if (alreadySent(state.sent, index)) return { status: 'already-sent' };
    if (isLate(startedAt, lesson, now(), state.course.late_after_hours)) return holdLate(state, index);
    const resolved = await invokeTarget('contact-points.resolve', { account_id: state.account_id });
    const email = resolved?.address;
    if (typeof email !== 'string' || !EMAIL.test(email)) throw new Error('Subscriber email could not be resolved.');
    const unsubscribeUrl = stopUrl(state.course, token);
    const latest = currentPayload(await readCurrent(address));
    if (!isActive(latest) || latest.unsubscribe_token !== token || await stopped(latest)) return { status: 'unsubscribed' };
    let sent;
    try {
      sent = await invokeTarget('send-email', {
        template: 'account-onboarding', to: email, ...(state.course.reply_to === undefined ? {} : { reply_to: state.course.reply_to }),
        idempotencyKey: `email-course:${digest(JSON.stringify([address, index]))}`,
        message: messageFor(state.course, lesson),
        // A receipt carries neither the unsubscribe copy nor the mailing address, and no unsubscribe headers.
        variables: { ...(state.variables ?? {}), articleUrl: lesson.article_url, ...(state.course.checkout_url === undefined ? {} : { checkoutUrl: state.course.checkout_url }),
          ...(lesson.receipt ? {} : { unsubscribeUrl, mailingAddress: state.course.mailing_address }) },
        headers: lesson.receipt ? {} : { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      if (sent?.ok !== true || typeof sent.provider_message_id !== 'string') throw new Error('Email provider did not confirm the lesson.');
    } catch (error) {
      if (retry < 3 && state.course.retry_failed !== false) await schedule(state, index, retry + 1);
      throw error;
    }
    const current = await readCurrent(address);
    const currentState = currentPayload(current);
    if (isActive(currentState) && !alreadySent(currentState.sent, index)) {
      await persist([{ address_label: address, expected_current: expectedCurrent(current), path_labels: ['email-course', 'email-course-subscription'], payload: { ...currentState, sent: { ...currentState.sent, [index]: { at: now().toISOString(), provider_message_id: sent.provider_message_id } } } }]);
    }
    return { status: 'sent', lesson_index: index, provider_message_id: sent.provider_message_id };
  }

  async function enroll({ email, basis, course, source, enrollment_key: enrollmentKey, waits_until: waitsUntil, variables }) {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (normalized.length > 254 || !EMAIL.test(normalized)) throw new Error('Enter a valid email address.');
    assertCourse(course);
    const kept = basisOf(basis, course, now());
    const own = variablesOf(variables);
    if (enrollmentKey !== undefined && !keyText(enrollmentKey)) throw new Error('An enrollment key is a non-empty name of at most 300 characters.');
    if (course.waits === true) {
      if (enrollmentKey === undefined) throw new Error('A course that waits on its caller needs an enrollment_key, so each yes names its enrollment.');
      if (typeof waitsUntil !== 'boolean') throw new Error('This enrollment waits on its caller: give waits_until, true or false.');
    }
    const imported = await invokeTarget('contact-points.import', {
      source: 'public-email-course', rows: [{ email: normalized, source_ref: `email-course:${course.id}`, at: now().toISOString() }],
    });
    const accountId = imported?.rows?.find((row) => row?.account_id)?.account_id;
    if (typeof accountId !== 'string' || !accountId) throw new Error('Email enrollment could not be saved.');
    const address = subscriptionAddress(course.id, accountId, enrollmentKey);
    // The first lesson goes now unless this enrollment is still waiting on its caller; then it is queued like the others. A
    // first lesson that fails is answered, not thrown: the enrollment stands (its rows are kept) and a retry is queued as
    // the course allows, so a failed send never loses the sign-up.
    async function startLessons(state) {
      const first = state.waits === true && !waitsUntil ? 0 : 1;
      for (let index = first; index < state.course.lessons.length; index++) await schedule(state, index);
      if (first === 0) return { status: 'waiting' };
      if (state.sent?.[0]) return { status: 'already-sent' };
      try {
        const { status } = await deliver({ token: state.unsubscribe_token, lesson_index: 0, waits_until: waitsUntil });
        return { status };
      } catch (error) {
        return { status: 'failed', why: error.message };
      }
    }
    async function resumeActive(state) {
      return { status: 'enrolled', already_enrolled: true, first_lesson: await startLessons(state) };
    }
    let existing = currentPayload(await readCurrent(address));
    if (isActive(existing)) return resumeActive(existing);
    const token = mintToken();
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('Unsubscribe token could not be minted.');
    const enrolledAt = now().toISOString();
    const startedAt = kept.kind === 'transaction' && kept.at !== undefined ? kept.at : enrolledAt;
    const state = {
      kind: 'email-course-subscription', status: 'active', account_id: accountId,
      subscription_address: address, unsubscribe_token: token, course, basis: kept,
      ...(enrollmentKey === undefined ? {} : { enrollment_key: enrollmentKey }), waits: course.waits === true, started_at: startedAt,
      enrolled_at: enrolledAt,
      ...(kept.kind === 'consent' ? { consented_at: enrolledAt, consent_text: kept.text, consent_version: course.consent_version ?? '1' } : {}),
      ...(Object.keys(own).length ? { variables: own } : {}),
      source: typeof source === 'string' ? source.slice(0, 300) : '', sent: {},
    };
    const current = await readCurrent(address);
    existing = currentPayload(current);
    if (isActive(existing)) return resumeActive(existing);
    // A fresh consent in the course's own words lifts an earlier stop of the same scope; a transaction never does.
    const stop = stopAddress(stopScopeOf(course), accountId);
    const stopNow = kept.kind === 'consent' ? await readCurrent(stop) : null;
    try {
      await persist([
        { address_label: address, expected_current: expectedCurrent(current), path_labels: ['email-course', 'email-course-subscription'], payload: state },
        { address_label: tokenAddress(token), expected_current: { content_hash: null }, path_labels: ['email-course', 'email-course-token'], payload: { subscription_address: address } },
        ...(stopNow?.found ? [{ address_label: stop, expected_current: expectedCurrent(stopNow), path_labels: ['email-course', 'email-course-stop'], payload: null }] : []),
      ]);
    } catch (error) {
      // Two submissions can read the same empty address. If the other CAS write
      // won, finish from that durable consent instead of reporting a failure.
      const winner = currentPayload(await readCurrent(address));
      if (isActive(winner)) return resumeActive(winner);
      throw error;
    }
    return { status: 'enrolled', already_enrolled: false, first_lesson: await startLessons(state) };
  }

  async function captureInterest({ email, consent, course, source }) {
    if (consent !== true) throw new Error('Please agree to receive one update if the lesson series becomes available.');
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (normalized.length > 254 || !EMAIL.test(normalized)) throw new Error('Enter a valid email address.');
    if (!course || typeof course !== 'object' || course.capture_only !== true
      || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(course.id ?? '')
      || typeof course.public_origin !== 'string' || new URL(course.public_origin).protocol !== 'https:'
      || new URL(course.public_origin).pathname !== '/' || new URL(course.public_origin).search || new URL(course.public_origin).hash
      || typeof course.consent_text !== 'string' || !course.consent_text.trim()
      || typeof course.consent_version !== 'string' || !course.consent_version.trim()) {
      throw new Error('Email update list is unavailable.');
    }

    const address = interestAddress(course.id, normalized);
    const current = await readCurrent(address);
    const existing = currentPayload(current);
    if (existing?.kind === 'email-course-interest' && existing.status === 'pending'
      && existing.email === normalized && existing.course_id === course.id
      && existing.consent_text === course.consent_text && existing.consent_version === course.consent_version) {
      return { status: 'interest_saved', already_saved: true };
    }
    const state = {
      kind: 'email-course-interest', status: 'pending', email: normalized,
      course_id: course.id, purpose: 'one-update-if-available',
      consented_at: now().toISOString(), consent_text: course.consent_text,
      consent_version: course.consent_version, source: typeof source === 'string' ? source.slice(0, 300) : '',
    };
    try {
      await persist([{
        address_label: address,
        expected_current: expectedCurrent(current),
        path_labels: ['email-course', 'email-course-interest'],
        payload: state,
      }]);
    } catch (error) {
      // A concurrent submission can win the same compare-and-swap. Confirm its
      // durable consent before reporting success; other write failures still fail.
      const winner = currentPayload(await readCurrent(address));
      if (winner?.kind === 'email-course-interest' && winner.status === 'pending'
        && winner.email === normalized && winner.course_id === course.id
        && winner.consent_text === course.consent_text && winner.consent_version === course.consent_version) {
        return { status: 'interest_saved', already_saved: true };
      }
      throw error;
    }
    return { status: 'interest_saved', already_saved: false };
  }


  // The token's link stops its subscription and keeps a stop for the contact over the course's stop scope, so every other
  // enrollment of that contact in the scope is sent nothing more. An old link whose subscription already stopped still
  // keeps the stop. A token that cannot be one of ours (not 32 to 100 letters, digits, - or _) answers malformed and keeps
  // nothing, so the page that took the link can say the link is broken; an unknown token of the right form answers
  // unsubscribed, so the answer never says which tokens exist.
  async function unsubscribe(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) return { status: 'malformed' };
    const mapping = currentPayload(await readCurrent(tokenAddress(token)));
    if (!mapping?.subscription_address) return { status: 'unsubscribed' };
    const current = await readCurrent(mapping.subscription_address);
    const state = currentPayload(current);
    if (!state || state.unsubscribe_token !== token) return { status: 'unsubscribed' };
    const stop = stopAddress(stopScopeOf(state.course), state.account_id);
    const stopNow = await readCurrent(stop);
    const at = now().toISOString();
    const writes = [
      ...(isActive(state) ? [{ address_label: mapping.subscription_address, expected_current: expectedCurrent(current), path_labels: ['email-course', 'email-course-subscription'], payload: { ...state, status: 'unsubscribed', unsubscribed_at: at } }] : []),
      ...(stopNow?.found ? [] : [{ address_label: stop, expected_current: { content_hash: null }, path_labels: ['email-course', 'email-course-stop'], payload: {
        kind: 'email-course-stop', scope: stopScopeOf(state.course), account_id: state.account_id, stopped_at: at, from_subscription: mapping.subscription_address,
      } }]),
    ];
    if (writes.length) await persist(writes);
    return { status: 'unsubscribed' };
  }

  return { enroll, captureInterest, deliver, unsubscribe };
}
