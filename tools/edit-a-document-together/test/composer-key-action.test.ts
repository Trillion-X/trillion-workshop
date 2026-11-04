// Behavioral verification of the composer keydown DECISION (C2/C3) — pure, engine-free, studio-free.
// This is the exact logic ComposerEditable.onKeyDown runs, lifted into a total function so the closing
// rules ("Backspace-empty / Escape closes the composer", "Enter submits, Shift+Enter is a newline",
// "an open overlay owns Arrow/Enter/Escape") are asserted directly instead of only through the shell.

import { describe, expect, it } from './vitest-shim.mjs';
import { composerKeyAction, type ComposerKeyFacts } from '../read-data/composer-key-action.ts';

const facts = (over: Partial<ComposerKeyFacts>): ComposerKeyFacts => ({
  key: 'a',
  shiftKey: false,
  isEmpty: false,
  overlayOpen: false,
  ...over,
});

describe('composerKeyAction — C2/C3 keystroke intents', () => {
  it('Enter (no overlay, no shift) submits', () => {
    expect(composerKeyAction(facts({ key: 'Enter' }))).toBe('submit');
  });

  it('Shift+Enter is a real newline, NOT a submit (falls through to type)', () => {
    expect(composerKeyAction(facts({ key: 'Enter', shiftKey: true }))).toBe('type');
  });

  it('Escape dismisses regardless of emptiness (C2 close + restore)', () => {
    expect(composerKeyAction(facts({ key: 'Escape', isEmpty: false }))).toBe('dismiss');
    expect(composerKeyAction(facts({ key: 'Escape', isEmpty: true }))).toBe('dismiss');
  });

  it('Backspace on an EMPTY composer dismisses (C2)', () => {
    expect(composerKeyAction(facts({ key: 'Backspace', isEmpty: true }))).toBe('dismiss');
  });

  it('Backspace on a NON-empty composer is ordinary editing (deletes a char), NOT a dismiss', () => {
    expect(composerKeyAction(facts({ key: 'Backspace', isEmpty: false }))).toBe('type');
  });

  it('an open overlay OWNS Arrow/Enter/Escape — the composer defers on all four', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      expect(composerKeyAction(facts({ key, overlayOpen: true }))).toBe('defer');
    }
  });

  it('an open overlay does NOT swallow ordinary typing or Backspace (only its four keys)', () => {
    expect(composerKeyAction(facts({ key: 'a', overlayOpen: true }))).toBe('type');
    // Backspace-empty still dismisses even with an overlay open (it is not overlay-owned).
    expect(composerKeyAction(facts({ key: 'Backspace', isEmpty: true, overlayOpen: true }))).toBe('dismiss');
  });

  it('ordinary character keys type', () => {
    expect(composerKeyAction(facts({ key: 'x' }))).toBe('type');
    expect(composerKeyAction(facts({ key: ' ' }))).toBe('type');
  });

  it('is total and deterministic — never throws, always one of the four intents', () => {
    const keys = ['Enter', 'Escape', 'Backspace', 'ArrowLeft', 'Tab', 'a', 'F5', ''];
    const intents = new Set(['defer', 'submit', 'dismiss', 'type']);
    for (const key of keys) {
      for (const shiftKey of [true, false]) {
        for (const isEmpty of [true, false]) {
          for (const overlayOpen of [true, false]) {
            expect(intents.has(composerKeyAction({ key, shiftKey, isEmpty, overlayOpen }))).toBe(true);
          }
        }
      }
    }
  });
});
