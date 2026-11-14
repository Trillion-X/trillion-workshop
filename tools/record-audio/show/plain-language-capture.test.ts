import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'packages/record-audio/show/RecordAudioPanel.tsx'), 'utf8');

describe('record-audio visible copy boundary', () => {
  it('sanitizes capture failures and keeps raw diagnostics off the recording screen', () => {
    expect(source).toContain('sanitizeErrorText(');
    expect(source).not.toContain('{diagnostics.slice');
  });
});
