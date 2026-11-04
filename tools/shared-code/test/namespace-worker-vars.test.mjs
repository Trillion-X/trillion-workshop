import assert from 'node:assert/strict';
import test from 'node:test';
import { namespaceWorkerVars } from '../scripts/namespace-worker-vars.mjs';

test('namespace Worker vars bind published files to the first configured object bucket', () => {
  const origins = [
    { row: { id: 'remote-primary', interface: 's3-compatible', settings: { endpoint: 'https://files.example', region: 'test' } } },
    { row: { id: 'object-primary', interface: 'object-bucket', binding: 'NAMESPACE_BYTES_OBJECT_PRIMARY' } },
    { row: { id: 'object-archive', interface: 'object-bucket', binding: 'NAMESPACE_BYTES_OBJECT_ARCHIVE' } },
  ];

  assert.deepEqual(namespaceWorkerVars(origins), {
    NAMESPACE_ORIGINS: JSON.stringify(origins.map(({ row }) => row)),
    PUBLISHED_FILE_BINDING: 'NAMESPACE_BYTES_OBJECT_PRIMARY',
  });
});

test('namespace Worker vars fail when no configured object bucket can store published files', () => {
  assert.throws(
    () => namespaceWorkerVars([{ row: { id: 'remote', interface: 's3-compatible' } }]),
    /No usable object-bucket namespace origin/,
  );
});
