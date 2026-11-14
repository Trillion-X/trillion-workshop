import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveLocalFileCopy } from './save-local-file-copy';
import { invokeLocalFilesTarget } from '../read-data/invoke-local-files-target';
vi.mock('../read-data/invoke-local-files-target', () => ({ invokeLocalFilesTarget: vi.fn() }));
const invoke = vi.mocked(invokeLocalFilesTarget);
const input = { fileName: 'board.md', bytes: new TextEncoder().encode('Exact selected cards'), directory: '/private', copyId: 'copy-1' };
const path = '/private/board-copy-1.md';
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (request) => ({ success: true, operation: String(request.operation), path: String(request.path),
    files: [{ path, name: 'board-copy-1.md', byte_length: input.bytes.length, content_type: 'text/markdown', bytes_base64: btoa('Exact selected cards') }] }));
});
describe('save a local copy', () => {
  it('publishes without replacement and reads exact bytes before succeeding', async () => {
    await expect(saveLocalFileCopy(input)).resolves.toBe(path);
    expect(invoke.mock.calls.map(([request]) => request.operation)).toEqual(['write_new_file', 'read_file']);
  });
  it('does not overwrite when exclusive creation refuses', async () => {
    invoke.mockRejectedValueOnce(new Error('Already exists'));
    await expect(saveLocalFileCopy(input)).rejects.toThrow('Already exists');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each(['../secret', '/absolute', 'nested/file', 'bad\\name', '..'])('refuses unsafe name %s before writing', async (fileName) => {
    await expect(saveLocalFileCopy({ ...input, fileName })).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('does not report success for different saved bytes', async () => {
    invoke.mockImplementation(async (request) => ({ success: true, operation: String(request.operation), path,
      files: [{ path, name: 'board.md', byte_length: input.bytes.length, content_type: 'text/plain', bytes_base64: btoa('different') }] }));
    await expect(saveLocalFileCopy(input)).rejects.toThrow('could not be verified');
  });
  it('does not report a pending write as saved', async () => {
    invoke.mockResolvedValueOnce({ success: true, operation: 'accepted', path });
    await expect(saveLocalFileCopy(input)).rejects.toThrow('not been confirmed');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
