//
// RUN THE SCREEN AN AI WROTE.
//
// Any AI that answers through the door may write the screen for its answer: one HTML document, any CSS and script, in
// the call's `screen` field (laid on the door's one tool by the door's row, trillion-rust src/mcp/hosts.rs `tool_input`).
// This page holds that code and runs it, while the AI is still typing it, and hands it the answer and one way to act.
// It draws nothing of its own: no parts, no list of kinds, no rule about what an answer looks like. The code decides.
//
// Invariants
// - The code is put into the page as it grows, at most once per animation frame, with its scripts inert; once the call's
//   input is whole, the code is put in once more and its scripts run, once.
// - Before any script runs, `window[words.api_name ?? 'door']` is { answer, onAnswer(fn), run(method, input), size() }.
//   `answer` is the result's structured answer, else the `answer` the call itself carried (a show tool's). `run`
//   is the door's one tool (the words' `run_tool`) through the app, as the person who connected it, with a fresh 128-bit request key; it
//   resolves with the door's answer or rejects with the door's words, which are also said above the screen, so a call
//   the door refuses never looks like an empty answer. A call names only its method: the door finds the owner that
//   answers it. Nothing else of ours reaches the code.
// - When the call carried no code, the screens to try come in the order the page's own words give (`order`): each a
//   request the words name, run as the person. The first that answers code is run. When none does, the answer's own
//   text is shown as text.
// - A screen whose maker is not one the words call the person's own (`mine`) gets a `run` that first shows the call
//   and waits for a press. It is a different function, not a flag the code could change.
// - A screen the call carried is kept, once per distinct code (its BLAKE3), through the words' `keep` request; so is one a
//   request marked `keep_what_it_wrote` answered.
// - A request of the page's own that is refused (keeping a screen, reading a kept one) says so above the screen, in the
//   app's words; nothing the page asks fails silently.
// - The page follows the app's light or dark theme (`color-scheme`), so the code's default colors are readable in either.
// - A script that throws shows its words above the screen, with one press that asks for a new version, through the
//   words' `fix_order` (else `order`), given the error and the code that threw.
// - Nothing here branches on what an answer, a screen or an operation is.

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** Starts the page. `app` is the AI app's bridge (ai-app-bridge.mjs connectToAiApp), `words` the page's own words. */
export function runScreens(win, { connect, words = {} }) {
  const doc = win.document;
  const host = doc.getElementById(words.host ?? 'screen');
  let code = null, ran = null, wanted = null, call = null, answer = null, text = '', madeBy = null, tried = false;
  const hearers = new Set();
  const app = connect({ onToolInput, onToolResult, content: host });
  // The app's theme, as it says it (`theme` in its host context): the page and the code drawn in it follow it, so default
  // text is never dark on a dark app. Until it says, the device's own preference.
  doc.documentElement.style.colorScheme = 'light dark';
  app.onPlacement?.(context => { if (context?.theme === 'light' || context?.theme === 'dark') doc.documentElement.style.colorScheme = context.theme; });
  const requestKey = () => bytesToHex(win.crypto.getRandomValues(new Uint8Array(16)));
  // The door's one tool, by the name the owner's words give (`run_tool`).
  const send = (method, input) => app.callTool(words.run_tool ?? 'do_one_thing_in_my_account', { method, request_key: requestKey(), input: input ?? {} });
  // A request the words name, with each "{name}" string in it given its value.
  const asked = (request, values) => JSON.parse(JSON.stringify(request.input ?? {}), (_, value) =>
    typeof value === 'string' && /^\{\w+\}$/.test(value) ? values[value.slice(1, -1)] ?? null : value);
  const at = (value, pointer = '') => pointer.split('/').slice(1).reduce((here, step) => here?.[step], value);
  const forOperation = () => call ? [call.method ?? call.operation, call.input?.tool ?? ''].join(' ').trim() : '';

  function apiFor(maker) {
    const own = (words.mine ?? []).includes(maker);
    const allowed = own ? send : (method, input) => ask(method).then(() => send(method, input));
    // What the door refuses is said where the person looks, and still rejects for the code to handle.
    const run = (method, input) => allowed(method, input).catch(error => {
      say(`${words.refused ?? 'This did not work:'} ${error?.message ?? error}`);
      throw error;
    });
    return {
      get answer() { return answer; },
      onAnswer(hear) { hearers.add(hear); if (answer !== null) hear(answer); return () => hearers.delete(hear); },
      run,
      size: () => app.reportSize(),
    };
  }

  // A line this page itself says above the screen, with an optional press.
  function say(text, pressWords = null, onPress = null) {
    const line = doc.createElement('p');
    line.textContent = `${text} `;
    if (pressWords) {
      const press = doc.createElement('button');
      press.textContent = pressWords;
      press.onclick = () => { line.remove(); onPress(); };
      line.append(press);
    }
    host.before(line);
    app.reportSize();
  }

  // A call a screen not the person's own wants to make, and the press that lets it.
  const ask = what => new Promise(resolve => say(`${words.asks ?? 'This screen wants to run'} ${what}.`, words.allow ?? 'Allow', resolve));

  function paint() {
    wanted = null;
    if (code === null) return;
    if (ran === code) return;
    host.innerHTML = code;
    if (call?.whole) {
      ran = code;
      win[words.api_name ?? 'door'] = apiFor(madeBy);
      for (const old of host.querySelectorAll('script')) {
        const fresh = doc.createElement('script');
        for (const { name, value } of old.attributes) fresh.setAttribute(name, value);
        fresh.textContent = old.textContent;
        old.replaceWith(fresh);
      }
    }
    app.reportSize();
  }
  const soon = () => { if (wanted === null) wanted = win.requestAnimationFrame(paint); };

  function show(newCode, maker) {
    code = newCode;
    madeBy = maker;
    soon();
  }

  function onToolInput(args, { partial }) {
    call = { ...args, whole: !partial };
    // A call that carries the answer it shows (a show tool's `answer`) hands it over with its arguments.
    if (!partial && 'answer' in args) setAnswer(args.answer);
    if (typeof args.screen === 'string') show(args.screen, words.chat_maker ?? 'ai:chat');
    else if (!partial) soon();
  }

  function setAnswer(next) {
    answer = next ?? null;
    for (const hear of hearers) hear(answer);
  }

  async function onToolResult(result) {
    // The answer is the result's own structured answer, else the one the call carried.
    if (result.structuredContent != null || !(call && 'answer' in call)) setAnswer(result.structuredContent);
    text = (result.content ?? []).filter(block => typeof block?.text === 'string').map(block => block.text).join('\n');
    if (code !== null && madeBy === (words.chat_maker ?? 'ai:chat') && !result.isError) keep(code);
    if (code === null && !tried) { tried = true; await tryInOrder(); }
  }

  async function keep(kept) {
    if (!words.keep) return;
    const id = bytesToHex(blake3(new TextEncoder().encode(kept)));
    if (keep.done?.has(id)) return;
    (keep.done ??= new Set()).add(id);
    await send(words.keep.method, asked(words.keep, { id, for_operation: forOperation(), code: kept, made_by: madeBy })).catch(error => say(`${words.not_kept ?? 'This screen was not kept:'} ${error?.message ?? error}`));
  }

  async function tryInOrder(error = null) {
    // Outside an app (a page of its own) no request can be made, so none is tried.
    const order = win.parent === win ? [] : (error ? words.fix_order : null) ?? words.order ?? [];
    for (const name of order) {
      const request = words[name];
      if (!request) continue;
      const values = { for_operation: forOperation(), answer: JSON.stringify(answer), error, code };
      const found = await send(request.method, asked(request, values)).then(reply => at(reply, request.code_at), error => {
        say(`${words.not_found ?? 'A kept screen could not be read:'} ${error?.message ?? error}`);
        return null;
      });
      const row = Array.isArray(found) ? found[0] : found;
      const written = typeof row === 'string' ? row : row?.code;
      if (typeof written === 'string' && written.trim()) {
        call = { ...call, whole: true };
        show(written, row?.made_by ?? name);
        if (request.keep_what_it_wrote) keep(written);
        return;
      }
    }
    if (code === null) {
      const said = doc.createElement('p');
      said.textContent = text || JSON.stringify(answer, null, 2);
      said.style.whiteSpace = 'pre-wrap';
      host.replaceChildren(said);
      app.reportSize();
    }
  }

  win.addEventListener('error', event => say(event.message, words.fix ?? 'Fix', () => {
    const broken = code; code = null; ran = null; tryInOrder(`${event.message}\n\n${broken}`);
  }));

  // Opened as a page (an answer's link, outside any app), the answer comes in the address's fragment, under the name the
  // words give (`fragment_answer`), as base64url JSON. With no app there is nothing to ask, so the answer is shown as text.
  const carried = words.fragment_answer && new URLSearchParams(win.location.hash.slice(1)).get(words.fragment_answer);
  if (carried) {
    try {
      const json = new TextDecoder().decode(Uint8Array.from(win.atob(carried.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
      call = { whole: true };
      tried = true;
      onToolResult({ structuredContent: JSON.parse(json), content: [] }).then(() => tryInOrder());
    } catch { host.textContent = words.unreadable ?? 'This link holds no answer that can be read.'; }
  }

  return { app, current: () => ({ code, answer, madeBy }) };
}
