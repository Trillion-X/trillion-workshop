// src/connecting-without-the-store.mjs
//
// PURPOSE
//   An AI app connecting to Trillion (initialize, server/discover, tools/list, ping, notifications) is answered even
//   while the person's store is busy or resetting. Those answers are Trillion's shipped instructions and tool list, the
//   same text for every account, so they never had to wait for the store; the former sign-in check woke the store
//   first and a busy store answered 503 to everything, so no AI could even read how to use Trillion (2026-10-05: one
//   account's store was busy for over an hour and every app's initialize failed).
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only the methods named in connecting-without-the-store.json are answered without the work store's word. Every
//      call that reads or changes records still waits for current AccountControl rights and its addressed data owner.
//   2. The key itself is still checked: the Worker resolves it from its own key records before this runs. AccountControl
//      adds current revocation and reach; when that gate is slow, its last answer about this sign-in is used for
//      connecting discovery, and a sign-in it last refused stays refused.
//   3. The last answer only shapes a connection's answer (which tool descriptions are listed); it never authorizes a
//      read or a change. With no earlier answer, the sign-in's own ceiling chooses the list.
//   4. A gate answer that arrives after the wait is still kept, so the next connection reads it.
//   5. The same wait (store_wait_ms) bounds the public brand reads (/favicon.svg, /brand/current/*, src/brand-assets.mjs):
//      they answer with the last brand the store gave, else the bundled brand, and never with anything about a person.
//      The workspace page's response is bounded the same way by page_answers_ms (src/workspace-files.mjs).
//
import rules from '../../keep-and-wake-ai-sessions-on-this-computer/src/connecting-without-the-store.json' with { type: 'json' };

/** Whether this MCP message is one an app sends to connect, answered without waiting on the person's store. */
export const connectsWithoutStore = message => typeof message?.method === 'string'
  && (rules.methods.includes(message.method) || rules.method_prefixes.some(prefix => message.method.startsWith(prefix)));

/** The longest an initialize waits for the work waiting for the connecting AI (Trillion's own work for it is handed first, then read). */
export const CONNECT_WORK_MS = rules.connect_work_ms;
export const KEPT_ANSWER_SECONDS = rules.kept_answer_seconds;
/** The longest the workspace page's response stays open for the answers it carries (src/workspace-files.mjs). */
export const PAGE_ANSWERS_MOST_MS = rules.page_answers_ms;
/** The wait for the store that every answer which can do without it shares. */
export const STORE_WAIT_MS = rules.store_wait_ms;
/** How long the operator's brand presentation is used again without asking the store. */
export const BRAND_FRESH_SECONDS = rules.brand_fresh_seconds;

/** `promise`'s value when it settles within `ms`, else null (a failure is null too). The late promise is handed to
 *  `waitUntil` so its work (a write the store finishes) still completes after the reply. */
export async function answerWithin(promise, { ms = rules.store_wait_ms, waitUntil = () => {} } = {}) {
  const settled = Promise.resolve(promise).then(value => ({ value }), () => ({ value: null }));
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), ms); });
  const first = await Promise.race([settled, late]);
  clearTimeout(timer);
  if (first) return first.value;
  waitUntil(settled);
  return null;
}

/** The sign-in check for a connecting message: the gate's answer when it comes within the wait, else the last answer
 *  it gave about this sign-in (invariant 2), else the sign-in's own ceiling (invariant 3). `from_store` remains a
 *  legacy store timing marker; the gate answer's `current_gate` distinguishes live admission from a cached fallback. */
export async function signInForConnecting(authorization, { lastAnswer, keepAnswer, ceiling, waitUntil = () => {}, ms = rules.store_wait_ms }) {
  const kept = Promise.resolve(authorization).then(answer => { if (answer) return keepAnswer(answer).then(() => answer, () => answer); return answer; });
  const answer = await answerWithin(kept, { ms, waitUntil });
  if (answer) return { ...answer, from_store: answer.from_store ?? true };
  const last = await Promise.resolve().then(lastAnswer).catch(() => null);
  if (last) return { accepted: last.accepted === true, reach: last.reach ?? ceiling, client: last.client ?? null, plan_marks: null, from_store: false };
  return { accepted: true, reach: ceiling, client: null, plan_marks: null, from_store: false };
}

/** What is kept of the sign-in gate's answer: whether it accepted, how far it reaches and the client it named. */
export const keptPartOf = answer => ({ accepted: answer?.accepted === true, reach: answer?.reach ?? null, client: answer?.client ?? null });
