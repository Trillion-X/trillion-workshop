import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

// Exercised as a process for the same reason as its sibling: the request file in, the receipt
// file out, and the exit code ARE the contract. Path resolution is the two-step from that test,
// because under this runner `import.meta.url` is a server path rather than a filesystem one.
function scriptOnDisk() {
  const asUrl = new URL('./verify-selected-addressed-evidence.mjs', import.meta.url).pathname;
  if (isAbsolute(asUrl) && existsSync(asUrl)) return asUrl;
  const underRoot = join(process.cwd(), asUrl);
  if (existsSync(underRoot)) return underRoot;
  throw new Error(`the script under test was not found at ${asUrl} or ${underRoot}`);
}

const SCRIPT = scriptOnDisk();
const folder = tempFolder(join(tmpdir(), 'verify-selected-addressed-evidence-'));
const bytes = Buffer.from('staged evidence bytes\n', 'utf8');

let caseNumber = 0;
function verify(overrides: Record<string, unknown> = {}, evidence: Buffer = bytes) {
  const id = `case-${(caseNumber += 1)}`;
  const evidencePath = join(folder, `${id}.bin`);
  const requestPath = join(folder, `${id}.request.json`);
  const receiptPath = join(folder, `${id}.receipt.json`);
  writeFileSync(evidencePath, evidence);
  writeFileSync(requestPath, JSON.stringify({
    evidence_ref: 'evidence:one',
    source_ref: 'source:one',
    artifact_ref: { cas_address: '1f:abc' },
    media_type_ref: 'media:bin',
    content_digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    byte_length: bytes.byteLength,
    ...overrides,
  }));
  try {
    execFileSync(process.execPath, [SCRIPT, requestPath, evidencePath, receiptPath], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (error: any) {
    return { failed: true as const, stderr: String(error.stderr ?? '') };
  }
  return { failed: false as const, receipt: JSON.parse(readFileSync(receiptPath, 'utf8')) };
}

describe('verify-selected-addressed-evidence checks the digest it was GIVEN, not one it assumes', () => {
  it('writes a custody receipt when the bytes match', () => {
    const answer = verify();
    expect(answer.failed).toBe(false);
    if (answer.failed) return;
    expect(answer.receipt.kind).toBe('local-files.selected-addressed-evidence');
    expect(answer.receipt.byte_length).toBe(bytes.byteLength);
  });

  it('verifies under the algorithm the request NAMES, not under a hardcoded one', () => {
    // The defect this pins: the script computed sha256 unconditionally, which was invisible while
    // sha256 was the only thing anything produced. Its sibling now takes the algorithm from the
    // caller, so an expectation under any other one would have arrived here and been reported as
    // a digest mismatch, which reads as tampered bytes.
    const answer = verify({
      content_digest: `sha512:${createHash('sha512').update(bytes).digest('hex')}`,
    });
    expect(answer.failed).toBe(false);
    if (answer.failed) return;
    expect(answer.receipt.content_digest.startsWith('sha512:')).toBe(true);
  });

  it('says the algorithm is unserved rather than calling the bytes wrong', () => {
    const answer = verify({ content_digest: `zzz-no-such-algorithm:${'0'.repeat(64)}` });
    expect(answer.failed).toBe(true);
    if (!answer.failed) return;
    expect(answer.stderr).toContain('zzz-no-such-algorithm');
    expect(answer.stderr).not.toContain('mismatch');
  });

  it('separates a length difference from a digest difference, because they are repaired differently', () => {
    const shorter = verify({}, Buffer.from('staged\n', 'utf8'));
    expect(shorter.failed).toBe(true);
    if (shorter.failed) expect(shorter.stderr).toContain('byte length');

    const wrongDigest = verify({ content_digest: `sha256:${'0'.repeat(64)}` });
    expect(wrongDigest.failed).toBe(true);
    if (wrongDigest.failed) expect(wrongDigest.stderr).toContain('digest mismatch');
  });

  it('refuses a digest carrying no algorithm at all', () => {
    const answer = verify({ content_digest: 'a'.repeat(64) });
    expect(answer.failed).toBe(true);
    if (answer.failed) expect(answer.stderr).toContain('<algorithm>:<hex>');
  });

  it('still requires the artifact and source refs, which are the custody half', () => {
    expect(verify({ artifact_ref: null }).failed).toBe(true);
    expect(verify({ source_ref: '' }).failed).toBe(true);
  });
});
