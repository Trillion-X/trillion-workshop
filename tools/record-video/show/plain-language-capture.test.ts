import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'packages/record-video/show/RecordVideoPanel.tsx'), 'utf8');

describe('record-video visible copy boundary', () => {
  it('keeps role names, internal setup keys, and raw diagnostics off the recording screen', () => {
    expect(source).not.toMatch(/Founder preview|Start founder recording/);
    expect(source).not.toContain('{problem.key}: {problem.detail}');
    expect(source).not.toContain('{diagnostics.slice');
    expect(source).not.toContain('<Text variant="body">{recording.completionReasonRef}</Text>');
    expect(source).not.toContain('<Text variant="body">{recording.artifactDisposition}</Text>');
    expect(source).toContain('Stopped manually');
    expect(source).toContain('Stopped after silence');
    expect(source).toContain('Saved after a capture problem');
    expect(source).toContain("sanitizeErrorText(problem.detail, 'One setup check needs attention.')");
  });

  it('uses task language for the readiness controls', () => {
    expect(source).toContain('Check if ready');
    expect(source).toContain('Ready to record. Camera and microphone access applies only to this take.');
    expect(source).not.toMatch(/Evaluate readiness|Ready to authorize|time-bounded authorization/);
  });
});
