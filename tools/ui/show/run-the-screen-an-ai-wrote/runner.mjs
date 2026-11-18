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
// - Before any script runs, `window[words.api_name ?? 'door']` is { answer, onAnswer(fn), run(address, method, input), size() }. `run`
//   is the door's one tool through the app, as the person who connected it, with a fresh 128-bit request key; it
//   resolves with the door's answer or rejects with the door's words. Nothing else of ours reaches the code.
// - When the call carried no code, the screens to try come in the order the page's own words give (`order`): each a
//   request the words name, run as the person. The first that answers code is run. When none does, the answer's own
//   text is shown as text.
// - A screen whose maker is not one the words call the person's own (`mine`) gets a `run` that first shows the call
//   and waits for a press. It is a different function, not a flag the code could change.
// - A screen the call carried is kept, once per distinct code (its BLAKE3), through the words' `keep` request; so is one a
//   request marked `keep_what_it_wrote` answered.
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
  const requestKey = () => bytesToHex(win.crypto.getRandomValues(new Uint8Array(16)));
  const send = (address, method, input) => app.callTool('run_resource_operation', { address, method, request_key: requestKey(), input: input ?? {} });
  // A request the words name, with each "{name}" string in it given its value.
  const asked = (request, values) => JSON.parse(JSON.stringify(request.input ?? {}), (_, value) =>
    typeof value === 'string' && /^\{\w+\}$/.test(value) ? values[value.slice(1, -1)] ?? null : value);
  const at = (value, pointer = '') => pointer.split('/').slice(1).reduce((here, step) => here?.[step], value);
  const forOperation = () => call ? [call.address ?? call.resource, call.method ?? call.operation, call.input?.tool ?? ''].join(' ').trim() : '';

  function apiFor(maker) {
    const own = (words.mine ?? []).includes(maker);
    const run = own ? send : (address, method, input) => ask(`${address} ${method}`).then(() => send(address, method, input));
    return {
      get answer() { return answer; },
      onAnswer(hear) { hearers.add(hear); if (answer !== null) hear(answer); return () => hearers.delete(hear); },
      run,
      size: () => app.reportSize(),
    };
  }

  // The one line this page itself says: a call a screen not the person's own wants to make, and the press that lets it.
  function ask(what) {
    return new Promise(resolve => {
      const line = doc.createElement('p');
      const press = doc.createElement('button');
      line.textContent = `${words.asks ?? 'This screen wants to run'} ${what}. `;
      press.textContent = words.allow ?? 'Allow';
      press.onclick = () => { line.remove(); resolve(); };
      line.append(press);
      host.before(line);
    });
  }

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
    if (typeof args.screen === 'string') show(args.screen, words.chat_maker ?? 'ai:chat');
    else if (!partial) soon();
  }

  async function onToolResult(result) {
    answer = result.structuredContent ?? null;
    text = (result.content ?? []).filter(block => typeof block?.text === 'string').map(block => block.text).join('\n');
    for (const hear of hearers) hear(answer);
    if (code !== null && madeBy === (words.chat_maker ?? 'ai:chat') && !result.isError) keep(code);
    if (code === null && !tried) { tried = true; await tryInOrder(); }
  }

  async function keep(kept) {
    if (!words.keep) return;
    const id = bytesToHex(blake3(new TextEncoder().encode(kept)));
    if (keep.done?.has(id)) return;
    (keep.done ??= new Set()).add(id);
    await send(words.keep.address, words.keep.method, asked(words.keep, { id, for_operation: forOperation(), code: kept, made_by: madeBy })).catch(() => {});
  }

  async function tryInOrder(error = null) {
    // Outside an app (a page of its own) no request can be made, so none is tried.
    const order = win.parent === win ? [] : (error ? words.fix_order : null) ?? words.order ?? [];
    for (const name of order) {
      const request = words[name];
      if (!request) continue;
      const values = { for_operation: forOperation(), answer: JSON.stringify(answer), error, code };
      const found = await send(request.address, request.method, asked(request, values)).then(reply => at(reply, request.code_at), () => null);
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

  win.addEventListener('error', event => {
    const said = doc.createElement('p');
    const fix = doc.createElement('button');
    said.textContent = `${event.message} `;
    fix.textContent = words.fix ?? 'Fix';
    fix.onclick = () => { said.remove(); const broken = code; code = null; ran = null; tryInOrder(`${event.message}\n\n${broken}`); };
    said.append(fix);
    host.before(said);
  });

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
