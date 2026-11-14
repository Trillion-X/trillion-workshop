import { describe, expect, it, vi } from 'vitest';
import { BoardOutputPartialFailure, requestBoardOutputDelivery, type BoardOutputSender } from './request-board-output';
import { ownerValidatedProcessResultWire } from '@/tests/fixtures/process-result-wire';
import { readBoardOutputTargets } from '../read-data/board-output-targets';

vi.mock('#workspace-records', () => ({ sendRequestToBitfieldTarget: vi.fn() }));

const route = { target: 'slot::workflow', definitionId: 'action:deliver' };
const artifacts = [{ fileName: 'board.md', mimeType: 'text/markdown', text: 'Selected card' }];
const reply = (body: unknown) => ({ payload: new TextEncoder().encode(JSON.stringify(body)) });
function savedFileResult(path = '/tmp/board.md\n') {
  const result = ownerValidatedProcessResultWire(path);
  return {
    ...result,
    captured_fds: result.captured_fds.map(({ sha256, ...capture }) => ({ ...capture, content_hash: `12:${sha256}` })),
    containment_receipt: { ...result.containment_receipt, checksum: `12:${result.containment_receipt.checksum}` },
  };
}

describe.each(['process', 'workflow'] as const)('%s saved-file confirmation', (method) => {
  const destination = method === 'workflow' ? route : { target: 'compute.process' };
  const response = (stdout: string) => reply(method === 'workflow'
    ? { status: 'completed', output: savedFileResult(stdout) }
    : savedFileResult(stdout));
  it.each(['', 'board.md\n', '/tmp/one.md\n/tmp/two.md\n'])('rejects an incomplete file list %j despite zero exit', async (stdout) => {
    await expect(requestBoardOutputDelivery(destination, artifacts, 0, async () => response(stdout)))
      .rejects.toThrow('File delivery has not been confirmed.');
  });
  it('requires a distinct saved path for every artifact', async () => {
    await expect(requestBoardOutputDelivery(destination, [...artifacts, ...artifacts], 0,
      async () => response('/tmp/one.md\n/tmp/one.md\n')))
      .rejects.toThrow('File delivery has not been confirmed.');
  });
  it('accepts one absolute saved path per artifact', async () => {
    await expect(requestBoardOutputDelivery(destination, artifacts, 0, async () => response('/tmp/board.md\n')))
      .resolves.toEqual({ method: method === 'workflow' ? 'workflow' : 'file-save', paths: ['/tmp/board.md'] });
  });
});

describe('workflow output confirmation', () => {
  it.each(['accepted', 'running', 'failed', 'denied', 'cancelled'])('does not report %s as delivered', async (status) => {
    await expect(requestBoardOutputDelivery(route, artifacts, 0, async () => reply({ status })))
      .rejects.toThrow('File delivery has not been confirmed.');
  });

  it.each([undefined, {}, { payload: new Uint8Array([255]) }, reply({ status: 'completed', error: 'failed' })])
    ('refuses an unreadable or contradictory reply', async (response) => {
      await expect(requestBoardOutputDelivery(route, artifacts, 0, async () => response)).rejects.toThrow();
    });

  it.each([null, {}, { artifacts }, { status: 'accepted', delivered: true }, { status: 'denied', delivered: true }, { ok: false, delivered: true }, { success: false, delivered: true }, { accepted: false, delivered: true }, { error: 'Save failed', delivered: true }])
    ('does not mistake workflow completion for owner success', async (output) => {
      await expect(requestBoardOutputDelivery(route, artifacts, 0, async () => reply({ status: 'completed', output })))
        .rejects.toThrow();
    });

  it('waits for completion and preserves the exact request', async () => {
    const sender = vi.fn<BoardOutputSender>(async () => reply({ status: 'completed', definition_id: route.definitionId, output: savedFileResult() }));
    await expect(requestBoardOutputDelivery(route, artifacts, 0, sender))
      .resolves.toEqual({ method: 'workflow', paths: ['/tmp/board.md'] });
    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.calls[0][0].payload).toMatchObject({
      definition_id: route.definitionId,
      input: { artifacts: [{ file_name: 'board.md', mime_type: 'text/markdown', bytes: btoa('Selected card') }] },
    });
  });
});

describe('declared native file destination', () => {
  const native = { target: 'local.files', fileOperation: 'write_new_file' as const, destinationDir: '/private' };
  it('preserves verified files when a later save fails without retrying or claiming remaining files', async () => {
    let saved = '';
    let writes = 0;
    const sender: BoardOutputSender = async ({ payload }) => {
      if (payload.operation === 'write_new_file') {
        if (++writes === 2) throw new Error('Disk full');
        saved = String(payload.path);
        return reply({ success: true, operation: 'write_new_file', path: saved });
      }
      return reply({ success: true, operation: 'read_file', files: [{ path: saved,
        byte_length: artifacts[0].text.length, bytes_base64: btoa(artifacts[0].text) }] });
    };
    const error = await requestBoardOutputDelivery(native, [...artifacts, ...artifacts, ...artifacts], 0, sender)
      .then(() => { throw new Error('Unexpected success'); }, error => error);
    expect(error).toBeInstanceOf(BoardOutputPartialFailure);
    expect(error.confirmedPaths).toEqual([saved]);
    expect(Object.isFrozen(error.confirmedPaths)).toBe(true);
    expect(error.failedArtifactIndex).toBe(1);
    expect(error.cause.message).toBe('Disk full');
    expect(writes).toBe(2);
  });
  it('uses the real helper and adapter and waits for exact byte readback', async () => {
    let saved = '';
    let content = '';
    let releaseRead!: (reply: unknown) => void;
    const sender = vi.fn<BoardOutputSender>(async ({ target, payload }) => {
      expect(target).toBe('local.files');
      if (payload.operation === 'write_new_file') {
        saved = String(payload.path); content = String(payload.content_base64);
        return reply({ success: true, operation: 'write_new_file', path: saved });
      }
      return new Promise(resolve => { releaseRead = resolve; });
    });
    let finished = false;
    const pending = requestBoardOutputDelivery(native, artifacts, 0, sender).then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(sender).toHaveBeenCalledTimes(2));
    expect(finished).toBe(false);
    expect(saved).toMatch(/^\/private\/board-[a-z0-9-]+\.md$/);
    expect(content).toBe(btoa('Selected card'));
    releaseRead(reply({ success: true, operation: 'read_file', files: [{ path: saved, byte_length: artifacts[0].text.length, bytes_base64: content }] }));
    await expect(pending).resolves.toEqual({ method: 'file-save', paths: [saved] });
    expect(sender.mock.calls.map(([r]) => r.payload.operation)).toEqual(['write_new_file', 'read_file']);
  });

  it.each([false, 'true', undefined])('refuses a non-success native response %j without readback', async success => {
    const sender = vi.fn<BoardOutputSender>(async ({ payload }) => reply({ success, operation: payload.operation, path: payload.path }));
    await expect(requestBoardOutputDelivery(native, artifacts, 0, sender)).rejects.toThrow();
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched saved bytes', async () => {
    const sender: BoardOutputSender = async ({ payload }) => reply({ success: true, operation: payload.operation, path: payload.path,
      files: [{ path: payload.path, byte_length: artifacts[0].text.length, bytes_base64: btoa('different') }] });
    await expect(requestBoardOutputDelivery(native, artifacts, 0, sender)).rejects.toThrow('could not be verified');
  });

  it.each([{ target: 'compute.process', file_operation: 'write_new_file' }, { target: 'local.files', file_operation: 'write_file' },
    { target: 'local.files', file_operation: 'write_new_file', definition_id: 'action:other' }])('rejects an ambiguous native route %j', route => {
    const targets = readBoardOutputTargets([{ payload: { kind: 'output-target-catalog', targets: [{ id: 'native', label: 'Native', route }] } }]);
    expect(targets.some(target => target.id === 'native')).toBe(false);
  });

  it('reads an explicit native copy route without changing the default Downloads route', () => {
    const targets = readBoardOutputTargets([{ payload: { kind: 'output-target-catalog', targets: [{ id: 'native', label: 'Native', route: native }] } }]);
    expect(targets.find(target => target.id === 'native')?.route).toEqual(native);
    expect(targets.find(target => target.id === 'downloads')?.route).toEqual({ target: 'compute.process' });
  });
});
