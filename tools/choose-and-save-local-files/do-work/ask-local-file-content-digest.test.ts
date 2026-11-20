import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import { execFileSync } from 'node:child_process';
import { createHash, getHashes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';

// This is a CLI, so it is exercised as one. Importing it would run it against this test's argv,
// and the thing every caller actually depends on is the process contract: what lands on stdout,
// what lands on stderr, and the exit code. A test that reached past that would pass while the
// contract callers rely on was broken.
//
// The path needs two steps, and the first attempt at one step failed in a way worth recording.
// Under this runner `import.meta.url` is a SERVER path rooted at the project (`/packages/...`),
// not a filesystem path, so spawning it produced four identical module-not-found errors that read
// like the script was broken. Resolving against the runner's root recovers the real file, and the
// existence assertion below turns any future resolution change into one clear failure instead of
// one per case.
function scriptOnDisk() {
  const asUrl = new URL('./ask-local-file-content-digest.mjs', import.meta.url).pathname;
  if (isAbsolute(asUrl) && existsSync(asUrl)) return asUrl;
  const underRoot = join(process.cwd(), asUrl);
  if (existsSync(underRoot)) return underRoot;
  throw new Error(`the script under test was not found at ${asUrl} or ${underRoot}`);
}

const SCRIPT = scriptOnDisk();

function ask(path: string, algorithm?: string) {
  const args = algorithm === undefined ? [SCRIPT, path] : [SCRIPT, path, algorithm];
  return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
}

function askExpectingRefusal(path: string, algorithm?: string) {
  const args = algorithm === undefined ? [SCRIPT, path] : [SCRIPT, path, algorithm];
  try {
    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: 'pipe' });
  } catch (error: any) {
    return { status: error.status, stderr: String(error.stderr ?? '') };
  }
  throw new Error('the script answered where it was expected to refuse');
}

describe('ask-local-file-content-digest says what a file IS, and refuses rather than guessing', () => {
  const folder = tempFolder(join(tmpdir(), 'ask-local-file-content-digest-'));
  const file = join(folder, 'directive-quote.txt');
  const bytes = Buffer.from('bind a contract to an artifact, never to a remembered quote\n', 'utf8');
  writeFileSync(file, bytes);

  it('answers the digest of the FILE bytes, which is the whole point of the field', () => {
    // Computed here from the same bytes by an independent path. Asserting a literal would pin
    // this test to one fixture and stop it noticing a re-encode, which is the failure the
    // script's own header names: a digest of text that was decoded and re-encoded is a digest
    // of something else.
    const answer = ask(file);
    expect(answer.hex).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(answer.byte_length).toBe(bytes.byteLength);
  });

  it('carries both spellings, and the prefixed one is not the bare one with a label glued on', () => {
    // Callers need both, and the contract validator accepts only the bare 64 hex characters.
    const answer = ask(file);
    expect(answer.prefixed).toBe(`sha256:${answer.hex}`);
    expect(answer.hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults to sha256 because that is what the contract validator accepts, and says so in the answer', () => {
    expect(ask(file).algorithm).toBe('sha256');
  });

  it('can report the owner-selected source path while hashing mounted bytes', () => {
    const mounted = join(folder, 'mounted-selected-bytes');
    writeFileSync(mounted, bytes);
    const reported = '/owner-selected/source.json';
    const answer = JSON.parse(execFileSync(process.execPath, [SCRIPT, mounted, 'sha256', reported], { encoding: 'utf8' }));
    expect(answer.path).toBe(reported);
    expect(answer.hex).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('serves any algorithm the RUNTIME serves, so a new one needs no edit here', () => {
    // sha512 is a stand-in for "not the default". The rule under test is that the algorithm is
    // caller-named and the answer changes with it, not that this particular name is supported.
    const other = getHashes().find((name) => name !== 'sha256' && name.startsWith('sha5'));
    expect(other).toBeDefined();
    const answer = ask(file, other!);
    expect(answer.algorithm).toBe(other);
    expect(answer.hex).toBe(createHash(other!).update(bytes).digest('hex'));
    expect(answer.hex).not.toBe(ask(file).hex);
  });

  it('refuses an algorithm this runtime does not serve, by name, and quotes back the set that exists', () => {
    // A wrong spelling must not fall back to the default. A digest under an algorithm the caller
    // did not ask for is indistinguishable from the right answer and binds a contract to a lie.
    const refusal = askExpectingRefusal(file, 'zzz-no-such-algorithm');
    expect(refusal.status).toBe(1);
    expect(refusal.stderr).toContain('zzz-no-such-algorithm');
    expect(JSON.parse(refusal.stderr).served).toContain('sha256');
  });

  it('refuses a missing path and a missing file, rather than answering for nothing', () => {
    expect(askExpectingRefusal('').status).toBe(1);
    expect(askExpectingRefusal(join(folder, 'no-such-file.txt')).status).toBe(1);
  });
});

describe('the digest is exposed through the canonical local-files action road', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'packages/local-files/things-to-store-and-run.json'), 'utf8'));
  const action = manifest.things.find((thing: any) => thing?.payload?.id === 'action:local-file-content-digest')?.payload;

  it('reads through local.files and never returns selected bytes', () => {
    expect(action).toBeDefined();
    expect(action.input_schema.required).toEqual(['path']);
    expect(action.steps[0].config.name).toBe('local.files');
    expect(action.steps[0].config.input.operation).toBe('read_file');
    expect(action.description).toContain('native inline-size refusal');
    expect(action.steps[2].config.name).toBe('compute.process');
    expect(action.steps[2].config.input.containment.kind).toBe('leaf');
    expect(JSON.stringify(action.steps[3])).not.toContain('bytes_base64');
  });

  it('names no user, provider, secret type, or fixed filesystem origin', () => {
    const serialized = JSON.stringify(action);
    expect(serialized).not.toContain('/Users/');
    expect(serialized.toLowerCase()).not.toContain('oauth');
    expect(serialized.toLowerCase()).not.toContain('client_secret');
  });
});
