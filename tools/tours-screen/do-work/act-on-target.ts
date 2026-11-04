// parts/guided-overlay/do-work/act-on-target.ts
//
// A tour step that DOES the thing instead of describing it. A step's `act` DATA names what to do to the real control it
// points at (`{ do: 'press' }`, `{ do: 'type', text }`, `{ do: 'choose', text }`, optionally `within`: a selector inside the
// target for the exact control); pressing the step's Next runs it on the page through the same events a person's own
// hand makes, so the screen answers exactly as it would to them, and the tour moves on once the page has answered.
// A `type` act with `every_ms` types letter by letter, as a hand would, so a visitor watching a live showcase sees the
// words arrive; every act answers how long it takes, so the tour waits for the last letter before it moves on.
// A `slide` act moves a range control (a slider) to the value in `text` a little at a time, `every_ms` apart, as a
// hand dragging it would, so a person watching sees what the control changes while it moves.
//
// BLIND (L090): the engine never names a screen, a control or an act. Each act is one entry in a registry keyed by the
// DATA's `do`; adding an act is registering one function, never editing the surface. Unknown acts do nothing (the step
// still advances), so malformed DATA never throws into the tour.

export interface StepAct {
  readonly do: string;
  /** A selector inside the target for the exact control to act on (a tab in a tab list, a field in a form). */
  readonly within?: string;
  /** Words to type, the visible words of the option to choose, or the value to slide to. */
  readonly text?: string;
  /** How a field commits its draft after input/change; the control still owns the result. */
  readonly commit?: 'blur' | 'enter';
  /** Milliseconds between letters when typing; absent or 0 puts the words in at once. */
  readonly every_ms?: number;
}

/** Runs an act on a control and answers how many milliseconds it keeps acting (0 or nothing: it is done at once). */
export type ActRunner = (control: Element, act: StepAct) => number | void;

export interface ActRegistry {
  register(name: string, run: ActRunner): ActRegistry;
  /** How many milliseconds the act keeps acting, or null when no act ran (unknown act, or no control to act on). */
  run(target: Element, act: StepAct): number | null;
}

/** Read an opaque `act` field off a step: an object with a string `do`, else null. */
export function readStepAct(value: unknown): StepAct | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const act = value as Record<string, unknown>;
  if (typeof act.do !== 'string' || !act.do) return null;
  return {
    do: act.do,
    ...(typeof act.within === 'string' && act.within ? { within: act.within } : {}),
    ...(typeof act.text === 'string' ? { text: act.text } : {}),
    ...(act.commit === 'blur' || act.commit === 'enter' ? { commit: act.commit } : {}),
    ...(typeof act.every_ms === 'number' && Number.isFinite(act.every_ms) && act.every_ms > 0 ? { every_ms: Math.min(act.every_ms, 1000) } : {}),
  };
}

export function createActRegistry(): ActRegistry {
  const runners = new Map<string, ActRunner>();
  const registry: ActRegistry = {
    register(name, run) {
      runners.set(name, run);
      return registry;
    },
    run(target, act) {
      const runner = runners.get(act.do);
      if (!runner) return null;
      const control = act.within ? target.querySelector(act.within) : target;
      if (!control) return null;
      const lasts = runner(control, act);
      return typeof lasts === 'number' && lasts > 0 ? lasts : 0;
    },
  };
  return registry;
}

// A person's press: pointer down and up, then the click, so controls that listen to either answer.
function press(control: Element): void {
  const view = control.ownerDocument.defaultView;
  const init = { bubbles: true, cancelable: true, composed: true, button: 0 };
  if (view && typeof view.PointerEvent === 'function') {
    control.dispatchEvent(new view.PointerEvent('pointerdown', { ...init, pointerType: 'mouse', isPrimary: true }));
    control.dispatchEvent(new view.PointerEvent('pointerup', { ...init, pointerType: 'mouse', isPrimary: true }));
  }
  if (control instanceof HTMLElement) {
    control.focus({ preventScroll: true });
    control.click();
  } else {
    control.dispatchEvent(new MouseEvent('click', init));
  }
}

// Typing into a field the way a framework-controlled field hears it: the element's own value setter, then input and change.
// With `every_ms`, each letter is one such input, `every_ms` apart; the change and the commit follow the last letter.
function type(control: Element, act: StepAct): number {
  const field = control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || (control as HTMLElement).isContentEditable
    ? control as HTMLElement
    : control.querySelector<HTMLElement>('input, textarea, [contenteditable="true"]');
  if (!field) return 0;
  const text = act.text ?? '';
  field.focus({ preventScroll: true });
  const put = (value: string) => {
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
    } else {
      field.textContent = value;
    }
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const finish = () => {
    field.dispatchEvent(new Event('change', { bubbles: true }));
    // Let a controlled field apply its input state before its own commit handler reads that draft.
    // Search boxes commonly commit on blur or Enter; the tour chooses the same gesture in DATA.
    if (act.commit === 'blur') window.setTimeout(() => field.blur(), 0);
    if (act.commit === 'enter') window.setTimeout(() => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
      field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    }, 0);
  };
  const letters = [...text];
  const every = act.every_ms ?? 0;
  if (!every || letters.length < 2) {
    put(text);
    finish();
    return 0;
  }
  letters.forEach((_, at) => window.setTimeout(() => {
    put(letters.slice(0, at + 1).join(''));
    if (at === letters.length - 1) finish();
  }, every * at));
  return every * letters.length;
}

// Choosing one of several: a native select takes the option whose words match; otherwise the control inside the target
// whose own words match is pressed (a tab, a radio, a menu row).
function choose(control: Element, act: StepAct): void {
  const words = (act.text ?? '').trim().toLowerCase();
  if (control instanceof HTMLSelectElement) {
    const option = [...control.options].find((one) => one.text.trim().toLowerCase() === words);
    if (!option) return;
    control.value = option.value;
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const candidates = [...control.querySelectorAll('button, [role="radio"], [role="tab"], [role="option"], [role="menuitem"], a')];
  const match = candidates.find((one) => (one.getAttribute('aria-label') ?? one.textContent ?? '').trim().toLowerCase() === words)
    ?? candidates.find((one) => (one.getAttribute('aria-label') ?? one.textContent ?? '').trim().toLowerCase().includes(words));
  if (match) press(match);
}

// Sliding a range control to a value the way a dragging hand does: the element's own value setter, then input, one
// small step at a time (about 20 steps, never finer than the control's own step); change follows the last one.
const SLIDE_STEPS = 20;
function slide(control: Element, act: StepAct): number {
  const range = control instanceof HTMLInputElement && control.type === 'range' ? control : control.querySelector<HTMLInputElement>('input[type="range"]');
  const to = Number.parseFloat(act.text ?? '');
  if (!range || !Number.isFinite(to)) return 0;
  const min = Number.parseFloat(range.min || '0'), max = Number.parseFloat(range.max || '100');
  const end = Math.min(max, Math.max(min, to));
  const start = Number.parseFloat(range.value);
  const from = Number.isFinite(start) ? start : min;
  const put = (value: number) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(range, String(value));
    range.dispatchEvent(new Event('input', { bubbles: true }));
  };
  range.focus({ preventScroll: true });
  const every = act.every_ms ?? 0;
  if (!every || from === end) { put(end); range.dispatchEvent(new Event('change', { bubbles: true })); return 0; }
  const step = Number.parseFloat(range.step);
  const fineness = Number.isFinite(step) && step > 0 ? step : 0;
  const count = Math.max(1, Math.min(SLIDE_STEPS, fineness ? Math.round(Math.abs(end - from) / fineness) : SLIDE_STEPS));
  for (let at = 1; at <= count; at += 1) {
    window.setTimeout(() => {
      put(at === count ? end : from + (end - from) * (at / count));
      if (at === count) range.dispatchEvent(new Event('change', { bubbles: true }));
    }, every * (at - 1));
  }
  return every * count;
}

/** The acts every tour can use. */
export function registerDefaultActs(registry: ActRegistry): ActRegistry {
  return registry
    .register('press', (control) => press(control))
    .register('type', type)
    .register('choose', choose)
    .register('slide', slide);
}
