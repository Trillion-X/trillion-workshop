// tools/send-messages/read-data/email-course.mjs
//
// Who agreed to get which emails. Generic public email-course owner. The host supplies DATA; capture-only mode
// stores one-update consent without sending, while enrolled lessons use the contact, send and lesson-schedule targets
// the caller hands in (do-work/keep-who-agreed.mjs gives them from the person's records and the sending tool).
import { makeHashCodeHexFromBytes } from '../../content-identity/read-data/identity.mjs';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN = /^[A-Za-z0-9_-]{40,100}$/;
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

function subscriptionAddress(courseId, accountId) {
  return `email-course.subscription::${digest(JSON.stringify([courseId, accountId]))}`;
}

function interestAddress(courseId, email) {
  return `email-course.interest::${digest(JSON.stringify([courseId, email]))}`;
}

function tokenAddress(token) {
  return `email-course.token::${digest(token)}`;
}

function assertCourse(course) {
  if (course?.capture_only === true) throw new Error('Email lessons are not ready to send.');
  if (!course || typeof course !== 'object' || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(course.id ?? '')) throw new Error('Email course is unavailable.');
  const origin = new URL(course.public_origin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Email course origin is invalid.');
  if (!Array.isArray(course.lessons) || course.lessons.length < 2 || course.lessons.length > 12) throw new Error('Email course has no valid lessons.');
  let previous = -1;
  for (const lesson of course.lessons) {
    if (!Number.isInteger(lesson.delay_hours) || lesson.delay_hours <= previous || lesson.delay_hours > 24 * 29) throw new Error('Email course lesson timing is invalid.');
    previous = lesson.delay_hours;
    if (typeof lesson.subject !== 'string' || !lesson.subject.trim() || !Array.isArray(lesson.text_lines) || !Array.isArray(lesson.html_lines)
      || !lesson.text_lines.every((line) => typeof line === 'string') || !lesson.html_lines.every((line) => typeof line === 'string')
      || !lesson.text_lines.join('\n').includes('{unsubscribeUrl}') || !lesson.html_lines.join('\n').includes('{unsubscribeUrl}')
      || !lesson.text_lines.join('\n').includes('{mailingAddress}') || !lesson.html_lines.join('\n').includes('{mailingAddress}')) throw new Error('Email course lesson copy is incomplete.');
    const article = new URL(lesson.article_url, origin);
    if (article.origin !== origin.origin) throw new Error('Email course lesson link is outside this site.');
  }
  if (typeof course.checkout_url !== 'string' || !course.checkout_url.trim()
    || new URL(course.checkout_url, origin).origin !== origin.origin) throw new Error('Email course checkout link is outside this site.');
  if (course.lessons[0].delay_hours !== 0 || typeof course.from !== 'string' || !course.from.trim()
    || typeof course.mailing_address !== 'string' || !course.mailing_address.trim()
    || typeof course.consent_text !== 'string' || !course.consent_text.trim()) throw new Error('Email course consent or sender is incomplete.');
  return origin;
}

function messageFor(course, lesson) {
  return {
    from: course.from,
    subject: lesson.subject,
    text_template: lesson.text_lines,
    html_template: lesson.html_lines,
  };
}

// The lesson that falls due at a time: the seam keeps it as a record, and send-due-email-lessons delivers it once it is due.
function lessonDue(state, index, retry = 0) {
  const lesson = state.course.lessons[index];
  const scheduledAt = new Date(Date.parse(state.consented_at) + lesson.delay_hours * 3_600_000 + (retry ? 2 ** retry * 3_600_000 : 0)).toISOString();
  const recordId = `email-course:${digest(state.subscription_address)}:${index}:${retry}`;
  return {
    record_id: recordId, due_at: scheduledAt, course_id: state.course.id, lesson_index: index, retry,
    token: state.unsubscribe_token, owner_ref: state.subscription_address,
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

  async function deliver({ token, lesson_index: index, retry = 0 }) {
    if (typeof token !== 'string' || !TOKEN.test(token) || !Number.isInteger(index) || index < 0
      || !Number.isInteger(retry) || retry < 0 || retry > 3) throw new Error('Invalid lesson request.');
    const tokenState = currentPayload(await readCurrent(tokenAddress(token)));
    if (!tokenState?.subscription_address) throw new Error('Lesson subscription was not found.');
    const address = tokenState.subscription_address;
    const before = await readCurrent(address);
    const state = currentPayload(before);
    if (!state || state.unsubscribe_token !== token) throw new Error('Lesson subscription changed.');
    if (state.status !== 'active') return { status: 'unsubscribed' };
    const lesson = state.course.lessons[index];
    if (!lesson) throw new Error('Lesson does not exist.');
    if (Date.parse(state.consented_at) + lesson.delay_hours * 3_600_000 > now().getTime()) return { status: 'not-due' };
    if (state.sent?.[index]) return { status: 'already-sent' };
    const resolved = await invokeTarget('contact-points.resolve', { account_id: state.account_id });
    const email = resolved?.address;
    if (typeof email !== 'string' || !EMAIL.test(email)) throw new Error('Subscriber email could not be resolved.');
    const unsubscribeUrl = `${state.course.public_origin}email-course/unsubscribe?token=${encodeURIComponent(token)}`;
    const latest = currentPayload(await readCurrent(address));
    if (latest?.status !== 'active' || latest.unsubscribe_token !== token) return { status: 'unsubscribed' };
    let sent;
    try {
      sent = await invokeTarget('send-email', {
        template: 'account-onboarding', to: email,
        idempotencyKey: `email-course:${digest(JSON.stringify([address, index]))}`,
        message: messageFor(state.course, lesson),
        variables: { articleUrl: lesson.article_url, checkoutUrl: state.course.checkout_url, unsubscribeUrl, mailingAddress: state.course.mailing_address },
        headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      });
      if (sent?.ok !== true || typeof sent.provider_message_id !== 'string') throw new Error('Email provider did not confirm the lesson.');
    } catch (error) {
      if (retry < 3) await schedule(state, index, retry + 1);
      throw error;
    }
    const current = await readCurrent(address);
    const currentState = currentPayload(current);
    if (currentState?.status === 'active' && !currentState.sent?.[index]) {
      await persist([{ address_label: address, expected_current: expectedCurrent(current), path_labels: ['email-course', 'email-course-subscription'], payload: { ...currentState, sent: { ...currentState.sent, [index]: { at: now().toISOString(), provider_message_id: sent.provider_message_id } } } }]);
    }
    return { status: 'sent', lesson_index: index, provider_message_id: sent.provider_message_id };
  }

  async function enroll({ email, consent, course, source }) {
    if (consent !== true) throw new Error('Please agree to receive the email lessons.');
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (normalized.length > 254 || !EMAIL.test(normalized)) throw new Error('Enter a valid email address.');
    assertCourse(course);
    const imported = await invokeTarget('contact-points.import', {
      source: 'public-email-course', rows: [{ email: normalized, source_ref: `email-course:${course.id}`, at: now().toISOString() }],
    });
    const accountId = imported?.rows?.find((row) => row?.account_id)?.account_id;
    if (typeof accountId !== 'string' || !accountId) throw new Error('Email enrollment could not be saved.');
    const address = subscriptionAddress(course.id, accountId);
    async function resumeActive(state) {
      for (let index = 1; index < state.course.lessons.length; index++) await schedule(state, index);
      if (!state.sent?.[0]) await deliver({ token: state.unsubscribe_token, lesson_index: 0 });
      return { status: 'enrolled', already_enrolled: true };
    }
    let existing = currentPayload(await readCurrent(address));
    if (existing?.status === 'active') return resumeActive(existing);
    const token = mintToken();
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('Unsubscribe token could not be minted.');
    const state = {
      kind: 'email-course-subscription', status: 'active', account_id: accountId,
      subscription_address: address, unsubscribe_token: token, course,
      consented_at: now().toISOString(), consent_text: course.consent_text,
      consent_version: course.consent_version ?? '1', source: typeof source === 'string' ? source.slice(0, 300) : '', sent: {},
    };
    const current = await readCurrent(address);
    existing = currentPayload(current);
    if (existing?.status === 'active') return resumeActive(existing);
    try {
      await persist([
        { address_label: address, expected_current: expectedCurrent(current), path_labels: ['email-course', 'email-course-subscription'], payload: state },
        { address_label: tokenAddress(token), expected_current: { content_hash: null }, path_labels: ['email-course', 'email-course-token'], payload: { subscription_address: address } },
      ]);
    } catch (error) {
      // Two submissions can read the same empty address. If the other CAS write
      // won, finish from that durable consent instead of reporting a failure.
      const winner = currentPayload(await readCurrent(address));
      if (winner?.status === 'active') return resumeActive(winner);
      throw error;
    }
    for (let index = 1; index < course.lessons.length; index++) await schedule(state, index);
    await deliver({ token, lesson_index: 0 });
    return { status: 'enrolled', already_enrolled: false };
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

  async function unsubscribe(token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('Invalid unsubscribe link.');
    const mapping = currentPayload(await readCurrent(tokenAddress(token)));
    if (!mapping?.subscription_address) return { status: 'unsubscribed' };
    const current = await readCurrent(mapping.subscription_address);
    const state = currentPayload(current);
    if (!state || state.unsubscribe_token !== token || state.status !== 'active') return { status: 'unsubscribed' };
    await persist([{ address_label: mapping.subscription_address, expected_current: expectedCurrent(current), path_labels: ['email-course', 'email-course-subscription'], payload: { ...state, status: 'unsubscribed', unsubscribed_at: now().toISOString() } }]);
    return { status: 'unsubscribed' };
  }

  return { enroll, captureInterest, deliver, unsubscribe };
}
