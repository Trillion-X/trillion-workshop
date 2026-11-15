// extension/src/page-actions.mjs
//
// PURPOSE
//   The engine that acts on a page for a run the person's Trillion handed to this browser: it finds each target by what the page
//   shows (its words, label, role), refuses a target that is missing or ambiguous, does one primitive operation, and says what it did.
//   It runs in the page (right-clicked.mjs asks it) and takes the document and window handed in, so it is tested in a real browser.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: no site, selector or control is named here. What an action is (its primitive, its input, its events), the fields a target
//      is matched on and every word are extension/page-actions.json.
//   2. One unambiguous target per step: more than one visible match needs an explicit nth, none is a refusal. Nothing is clicked by guess.
//   3. Text goes in through the control's value (or textContent of editable text), with the events a person's typing fires. Never markup.
//   4. A run is validated before it acts: every step's action, inputs and target are checked first (`dry_run` stops there), and a step
//      that cannot be done stops the run with the steps already done reported.
//   5. It answers only the extension's own background worker (right-clicked.mjs checks the sender), and never reads a password or cookie.
//
import settings from '../page-actions.json' with { type: 'json' };

const fill = (text, values) => String(text).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
const lower = value => String(value ?? '').toLowerCase().trim();
const canReadValue = element => !settings.withhold_values_from_types.includes(element.type);

function fieldValue(element, key) {
  if (key === 'value' && !canReadValue(element)) return undefined;
  if (key === 'innerText') return element.innerText;
  if (key === 'textContent') return element.textContent;
  if (key === 'tag') return element.tagName.toLowerCase();
  if (key === 'value') return typeof element.value === 'string' ? element.value : undefined;
  if (key === 'href') return element.href;
  return element.getAttribute?.(key) ?? undefined;
}
function fieldsOf(element) {
  const out = {};
  for (const [name, keys] of Object.entries(settings.fields)) {
    for (const key of keys) {
      const value = fieldValue(element, key);
      if (typeof value === 'string' && value.trim()) { out[name] = value.trim().replace(/\s+/g, ' '); break; }
    }
  }
  return out;
}
function grade(matcher, value) {
  if (value === undefined) return 0;
  const have = lower(value);
  if (typeof matcher === 'string') { const want = lower(matcher); return have === want ? 3 : have.startsWith(want) ? 2 : have.includes(want) ? 1 : 0; }
  if (matcher && typeof matcher === 'object') {
    if (matcher.equals !== undefined) return have === lower(matcher.equals) ? 3 : 0;
    if (matcher.contains !== undefined) return have.includes(lower(matcher.contains)) ? 3 : 0;
    if (matcher.starts_with !== undefined) return have.startsWith(lower(matcher.starts_with)) ? 3 : 0;
    if (matcher.regex !== undefined) { try { return new RegExp(matcher.regex, 'i').test(String(value)) ? 3 : 0; } catch { return 0; } }
  }
  return 0;
}
const visible = (element, win) => {
  const box = element.getClientRects();
  if (!box.length) return false;
  const style = win.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
};

// The refs a snapshot handed out, by id, until the next snapshot. An element that left the page is refused by name, not guessed.
let refs = new Map();

/** The visible elements the target matches, best grade first (page order among equals). */
export function locate(target, { document, window }) {
  if (target && typeof target === 'object' && typeof target.ref === 'string') {
    const element = refs.get(target.ref)?.deref();
    if (!element) return [];
    return element.isConnected ? [{ element, score: 1, fields: fieldsOf(element) }] : [];
  }
  const spec = typeof target === 'string' ? { match: { label: target } } : target;
  if (!spec?.match || typeof spec.match !== 'object') return [];
  const found = [];
  let seen = 0;
  for (const element of document.querySelectorAll(settings.candidates)) {
    if (++seen > settings.limits.max_candidates) break;
    if (!visible(element, window)) continue;
    const fields = fieldsOf(element);
    let score = 0;
    for (const [field, matcher] of Object.entries(spec.match)) {
      const one = grade(matcher, fields[field]);
      if (!one) { score = 0; break; }
      score += one;
    }
    if (score) found.push({ element, score, fields });
  }
  return found.sort((a, b) => b.score - a.score);
}

function setValue(element, text, append, events, window) {
  if (element.isContentEditable) {
    element.focus();
    element.textContent = append ? `${element.textContent}${text}` : text;
  } else if (typeof element.value === 'string') {
    const proto = Object.getPrototypeOf(element);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    element.focus();
    const next = append ? `${element.value}${text}` : text;
    if (setter) setter.call(element, next); else element.value = next;
  } else return false;
  for (const name of events) element.dispatchEvent(new window.Event(name, { bubbles: true }));
  return true;
}

const OPS = {
  click: ({ element, row, window }) => {
    for (let count = 1; count <= (row.count ?? 1); count += 1) {
      element.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, detail: count }));
      element.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, cancelable: true, detail: count }));
      element.click();
    }
    if (row.count === 2) element.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    return true;
  },
  hover: ({ element, window }) => { for (const name of ['mouseover', 'mouseenter', 'mousemove']) element.dispatchEvent(new window.MouseEvent(name, { bubbles: true })); return true; },
  focus: ({ element }) => { element.focus(); return true; },
  set_text: ({ element, row, step, window }) => {
    if (settings.refuse_types.includes(element.type)) return { error: fill(settings.words.refused_type, { type: element.type }) };
    return setValue(element, String(step[row.input]), row.append === true, row.events ?? [], window) || { error: settings.words.not_writable };
  },
  select: ({ element, row, step, window }) => {
    if (element.tagName !== 'SELECT') return { error: settings.words.not_writable };
    const want = lower(step[row.input]);
    const option = [...element.options].find(item => lower(item.textContent) === want || lower(item.value) === want);
    if (!option) return { error: fill(settings.words.no_option, { option: step[row.input] }) };
    element.value = option.value;
    for (const name of row.events ?? []) element.dispatchEvent(new window.Event(name, { bubbles: true }));
    return true;
  },
  key: ({ element, step, document, window }) => {
    const holder = element ?? document.activeElement ?? document.body;
    for (const name of ['keydown', 'keypress', 'keyup']) holder.dispatchEvent(new window.KeyboardEvent(name, { key: String(step.key), bubbles: true, cancelable: true }));
    return true;
  },
  drag: ({ element, destination, window }) => {
    const centre = item => { const box = item.getBoundingClientRect(); return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 }; };
    const transfer = new window.DataTransfer();
    const fire = (item, name, Kind) => item.dispatchEvent(new Kind(name, { bubbles: true, cancelable: true, dataTransfer: transfer, ...centre(item) }));
    fire(element, 'mousedown', window.MouseEvent);
    fire(element, 'dragstart', window.DragEvent);
    fire(destination, 'dragenter', window.DragEvent);
    fire(destination, 'dragover', window.DragEvent);
    fire(destination, 'drop', window.DragEvent);
    fire(element, 'dragend', window.DragEvent);
    fire(destination, 'mouseup', window.MouseEvent);
    return true;
  },
  snapshot: ({ document, window, list }) => {
    refs = new Map();
    let seen = 0;
    for (const element of document.querySelectorAll(settings.candidates)) {
      if (++seen > settings.limits.max_candidates || refs.size >= settings.limits.max_refs) break;
      if (!visible(element, window)) continue;
      const ref = `e${refs.size + 1}`;
      refs.set(ref, new WeakRef(element));
      list.push({ ref, ...fieldsOf(element), tag: element.tagName.toLowerCase() });
    }
    return true;
  },
  scroll: ({ element, step, window, document }) => {
    const holder = element ?? document.scrollingElement ?? document.documentElement;
    holder.scrollBy({ top: Number(step.dy) || 0, left: Number(step.dx) || 0 });
    return true;
  },
};

function check(step, context) {
  const row = Object.hasOwn(settings.actions, step?.do) ? settings.actions[step.do] : null;
  if (!row) return { error: fill(settings.words.unknown_action, { action: step?.do }) };
  if (row.input && (step[row.input] === undefined || step[row.input] === null)) return { error: fill(settings.words.needs_input, { action: step.do, input: row.input }) };
  let located = null;
  if (step.target?.ref !== undefined && !refs.has(step.target.ref)) return { error: fill(settings.words.bad_ref, { ref: step.target.ref }) };
  if (row.to === true && !step.to) return { error: fill(settings.words.needs_to, { action: step.do }) };
  if (row.target === true && !step.target) return { error: fill(settings.words.needs_target, { action: step.do }) };
  if (step.target) {
    const found = locate(step.target, context);
    const label = JSON.stringify(step.target);
    if (!found.length) return { error: step.target?.ref !== undefined ? fill(settings.words.gone_ref, { ref: step.target.ref }) : fill(settings.words.no_match, { target: label }) };
    const nth = step.nth === undefined ? null : step.nth;
    if (nth !== null && !(Number.isInteger(nth) && nth >= 0 && nth < found.length)) return { error: fill(settings.words.bad_nth, { last: found.length - 1 }) };
    if (nth === null && found.length > 1 && found[0].score === found[1].score) return { error: fill(settings.words.ambiguous, { count: found.length, target: label, last: found.length - 1 }) };
    located = found[nth ?? 0];
  }
  let destination = null;
  if (row.to === true) {
    const found = locate(step.to, context);
    const label = JSON.stringify(step.to);
    if (!found.length) return { error: fill(settings.words.no_match, { target: label }) };
    if (found.length > 1 && found[0].score === found[1].score && step.to_nth === undefined) return { error: fill(settings.words.ambiguous, { count: found.length, target: label, last: found.length - 1 }) };
    destination = found[step.to_nth ?? 0]?.element ?? null;
    if (!destination) return { error: fill(settings.words.bad_nth, { last: found.length - 1 }) };
  }
  return { row, located, destination };
}

/** Validates every step first, then (unless dry_run) does them in order. { results, dry_run, said } with `ok` on each step. */
export function actOnPage(message, context) {
  const steps = Array.isArray(message?.steps) ? message.steps : [];
  if (steps.length > settings.limits.max_steps) return { results: [], error: fill(settings.words.too_many, { max: settings.limits.max_steps }) };
  const results = [];
  for (const step of steps) {
    const checked = check(step, context);
    if (checked.error) { results.push({ do: step?.do, ok: false, detail: checked.error }); return { results, dry_run: message.dry_run === true, said: checked.error }; }
    if (message.dry_run !== true) {
      const list = [];
      const done = OPS[checked.row.op]({ element: checked.located?.element, destination: checked.destination, row: checked.row, step, list, ...context });
      if (done !== true) { results.push({ do: step.do, ok: false, detail: done.error }); return { results, dry_run: false, said: done.error }; }
      if (list.length) { results.push({ do: step.do, ok: true, elements: list }); continue; }
    }
    results.push({ do: step.do, ok: true, ...(checked.located ? { matched: checked.located.fields.label ?? checked.located.fields.text ?? checked.located.fields.role } : {}) });
  }
  return { results, dry_run: message.dry_run === true, said: fill(message.dry_run === true ? settings.words.dry : settings.words.done, { count: results.length }) };
}
