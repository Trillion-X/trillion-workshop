// extension/src/browser-session.mjs
//
// PURPOSE
//   Lets the person's AI drive a web page across several calls through the person's own signed-in browser: a session with an
//   unfocused window of its own, tabs it opened, navigation, acting on a page (including click by ref from a snapshot, drag,
//   fill, press, scroll), reading, and the person's lock that takes the browser back at once.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: which verbs exist, what each touches (`data_class`), the limits and every word are extension/browser-session.json.
//   2. Only tabs this session opened are listed, read or acted on; the person's own tabs are never touched.
//   3. The lock is the person's, held here in the host: while locked, every verb that is not a read, a tab list or an end is refused
//      before it reaches a page, whatever the call says. A call can lock but a call's own fields never unlock: `release` is a verb the
//      person's side must send, and the host records who held it.
//   4. A class listed in `limits.deny_classes` is refused in the host. The list is empty, so nothing is refused unless the person adds a class.
//   5. The window is never brought forward (focused false), and ending the session closes it.
//
import settings from '../browser-session.json' with { type: 'json' };

const fill = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
const refuse = (message, status = 403) => Object.assign(new Error(message), { status });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The sessions of this browser, by id: { window, tabs: Map(name → tab id), locked, last }. */
export function makeBrowserSessions({ browser = globalThis.chrome, config = settings, now = () => Date.now(), pause = wait } = {}) {
  const sessions = new Map();
  let counter = 0;

  const sweep = async () => {
    for (const [id, session] of sessions) {
      if (now() - session.last > config.limits.idle_minutes * 60_000) { await browser.windows.remove(session.window).catch(() => {}); sessions.delete(id); }
    }
  };
  const need = (input, name, verb) => { if (input[name] === undefined || input[name] === null || input[name] === '') throw refuse(fill(config.words.needs, { verb, name }), 400); return input[name]; };
  const urlOf = (input, verb) => {
    const url = String(need(input, 'url', verb));
    let parsed;
    try { parsed = new URL(url); } catch { throw refuse(fill(config.words.bad_scheme, { schemes: config.limits.schemes.join(' or ') }), 400); }
    if (!config.limits.schemes.includes(parsed.protocol)) throw refuse(fill(config.words.bad_scheme, { schemes: config.limits.schemes.join(' or ') }), 400);
    return url;
  };
  const tabOf = (session, input, verb) => {
    const name = String(need(input, 'tab', verb));
    if (!session.tabs.has(name)) throw refuse(fill(config.words.no_tab, { tab: name }), 404);
    return { name, id: session.tabs.get(name) };
  };
  async function loaded(tabId, url) {
    const until = now() + config.load.most_seconds * 1000;
    for (;;) {
      const tab = await browser.tabs.get(tabId);
      if (tab.status === 'complete') break;
      if (now() > until) throw refuse(fill(config.words.slow, { url, seconds: config.load.most_seconds }), 504);
      await pause(250);
    }
    await pause(config.load.settle_ms);
  }
  const describe = async session => ({ tabs: await Promise.all([...session.tabs].map(async ([name, id]) => {
    const tab = await browser.tabs.get(id).catch(() => null);
    return { tab: name, url: tab?.url ?? null, title: tab?.title ?? null };
  })), locked: session.locked });

  return {
    async call(input = {}) {
      await sweep();
      const verb = String(input.do ?? '');
      const row = Object.hasOwn(config.verbs, verb) ? config.verbs[verb] : null;
      if (!row) throw refuse(fill(config.words.unknown_verb, { verb }), 404);
      if (config.limits.deny_classes.includes(row.data_class)) throw refuse(fill(config.words.denied_class, { class: row.data_class }), 403);

      let id = input.session === undefined ? null : String(input.session);
      let session = id ? sessions.get(id) : null;
      if (id && !session) throw refuse(fill(config.words.no_session, { session: id }), 404);
      if (!session) {
        if (verb !== 'open') throw refuse(fill(config.words.no_session, { session: id ?? 'none' }), 404);
        if (sessions.size >= config.limits.max_sessions) throw refuse(fill(config.words.too_many_sessions, { max: config.limits.max_sessions }), 429);
        const url = urlOf(input, verb);
        const made = await browser.windows.create({ url, focused: false, state: 'minimized', type: 'normal' });
        id = `s${++counter}`;
        session = { window: made.id, tabs: new Map([['t1', made.tabs[0].id]]), locked: false, last: now(), next: 2 };
        sessions.set(id, session);
        await loaded(made.tabs[0].id, url);
        return { session: id, tab: 't1', ...(await describe(session)) };
      }
      session.last = now();
      if (session.locked && !row.while_locked) throw refuse(fill(config.words.locked, { verb }), 423);

      switch (verb) {
        case 'tabs': return { session: id, ...(await describe(session)) };
        case 'lock': session.locked = true; return { session: id, locked: true, said: config.words.locked_now };
        case 'release': session.locked = false; return { session: id, locked: false, said: config.words.released };
        case 'end': await browser.windows.remove(session.window).catch(() => {}); sessions.delete(id); return { ended: true, said: config.words.ended };
        case 'open': {
          if (session.tabs.size >= config.limits.max_tabs) throw refuse(fill(config.words.too_many_tabs, { max: config.limits.max_tabs }), 429);
          const url = urlOf(input, verb);
          const tab = await browser.tabs.create({ windowId: session.window, url, active: false });
          const name = `t${session.next++}`;
          session.tabs.set(name, tab.id);
          await loaded(tab.id, url);
          return { session: id, tab: name, ...(await describe(session)) };
        }
        case 'close': {
          const { name, id: tabId } = tabOf(session, input, verb);
          await browser.tabs.remove(tabId);
          session.tabs.delete(name);
          return { session: id, ...(await describe(session)) };
        }
        case 'navigate': {
          const { id: tabId } = tabOf(session, input, verb);
          const url = urlOf(input, verb);
          await browser.tabs.update(tabId, { url });
          await loaded(tabId, url);
          return { session: id, ...(await describe(session)) };
        }
        case 'back': case 'forward': {
          const { id: tabId } = tabOf(session, input, verb);
          await (verb === 'back' ? browser.tabs.goBack(tabId) : browser.tabs.goForward(tabId));
          await loaded(tabId, verb);
          return { session: id, ...(await describe(session)) };
        }
        case 'read': {
          const { id: tabId } = tabOf(session, input, verb);
          const page = await browser.tabs.sendMessage(tabId, { read_page: { max_text: config.load.max_text, max_links: config.load.max_links } });
          if (!page || page.error) throw refuse(page?.error ?? 'the page did not answer', 502);
          return { session: id, ...page };
        }
        case 'act': {
          const { id: tabId } = tabOf(session, input, verb);
          if (!Array.isArray(input.steps) || !input.steps.length) throw refuse(fill(config.words.needs, { verb, name: 'steps' }), 400);
          if (input.steps.length > config.limits.max_steps) throw refuse(fill(config.words.needs, { verb, name: `at most ${config.limits.max_steps} steps` }), 400);
          const done = await browser.tabs.sendMessage(tabId, { act_on_page: { steps: input.steps, dry_run: input.dry_run === true } });
          if (!done || done.error) throw refuse(done?.error ?? 'the page did not answer', 502);
          return { session: id, ...done };
        }
        default: throw refuse(fill(config.words.unknown_verb, { verb }), 404);
      }
    },
  };
}

let shared = null;
export const driveMyBrowser = input => (shared ??= makeBrowserSessions()).call(input);
