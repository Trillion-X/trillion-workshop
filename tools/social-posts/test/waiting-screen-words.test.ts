// The waiting screen fills its DATA sentences with say(), so the screen must import it: a call with no import is a
// ReferenceError the moment the screen draws. This reads the screen's source to hold that import in place.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { say } from '../web/src/workspace/decisions.ts';

const screenSource = readFileSync(new URL('../web/src/workspace/pieces-screen.tsx', import.meta.url), 'utf8');

describe('the waiting screen words', () => {
  it('fills the {name} places of a DATA sentence with the values given', () => {
    expect(say('{count} left', { count: 3 })).toBe('3 left');
    expect(say('Press {yes} to approve or {skip} to skip.', { yes: 'A', skip: 'S' })).toBe('Press A to approve or S to skip.');
  });

  it('imports say wherever it calls say, so the screen does not throw when it draws', () => {
    expect(screenSource).toMatch(/import \{[^}]*\bsay\b[^}]*\} from '\.\/decisions';/);
  });
});
