import test from 'node:test';
import assert from 'node:assert/strict';
import { stageFrozenInputs } from '../../shared-code/src/repo-explorer.mjs';

const asBytes = value => new TextEncoder().encode(value);
const asText = value => new TextDecoder().decode(value);
const response = (code = 0, stdout = '') => ({ code, stdout: asBytes(stdout), stderr: new Uint8Array() });
const persisted = value => JSON.parse(JSON.stringify(value));

function stagingContainer(backing = { running: false, file: new Uint8Array(), starts: 0, restores: 0, writes: [] }) {
  return {
    backing,
    status: async () => ({ state: backing.running ? 'preparing' : 'none' }),
    start: async () => {
      backing.running = true;
      backing.starts += 1;
      backing.file = new Uint8Array();
      return { started: true };
    },
    exec: async argv => {
      if (argv[0] === 'tar') { backing.restores += 1; return response(); }
      if (argv[0] === 'mkdir') return response();
      if (argv[0] === 'stat') return backing.file.length ? response(0, `${backing.file.length}\n`) : response(1);
      if (argv[0] === 'truncate') {
        backing.file = backing.file.subarray(0, Number(argv[2]));
        return response();
      }
      throw new Error(`Unexpected container command: ${argv.join(' ')}`);
    },
    claimStaging: async () => ({ claimed: true, token: 'staging-owner' }),
    releaseStaging: async token => assert.equal(token, 'staging-owner'),
    place: async (path, stream, { append, expected_offset } = {}) => {
      assert.equal(path, '/input/clip.mp4');
      assert.equal(backing.file.length, append ? expected_offset : 0, 'appends are fenced by the last stored byte');
      const chunk = new Uint8Array(await new Response(stream).arrayBuffer());
      backing.file = append ? Uint8Array.from([...backing.file, ...chunk]) : chunk;
      backing.writes.push({ append, expected_offset, chunk: asText(chunk) });
      return { placed: path };
    },
  };
}

function placement(bytes = asBytes('abcdefghij'), identity = 'clip-identity') {
  const ranges = [];
  return {
    ranges,
    input: {
      path: '/input/clip.mp4', identity, size: bytes.length,
      open: async (start, end) => {
        ranges.push([start, end]);
        return new Blob([bytes.subarray(start, end + 1)]).stream();
      },
    },
  };
}

test('a staged input resumes from the saved byte cursor after a Worker restart and duplicate wake', async () => {
  const sandbox = stagingContainer();
  const source = placement();
  const options = { sandbox, bytes: asBytes('tool-tar'), placements: [source.input], chunk_bytes: 4 };

  const first = await stageFrozenInputs(options);
  assert.equal(first.ready, false);
  assert.deepEqual(first.state.files, [{ path: '/input/clip.mp4', identity: 'clip-identity', size: 10, offset: 4 }]);

  // A later Worker isolate reopens the same task container and reads its durable task row.
  const restarted = stagingContainer(sandbox.backing);
  const second = await stageFrozenInputs({ ...options, sandbox: restarted, staging: persisted(first.state) });
  const third = await stageFrozenInputs({ ...options, sandbox: restarted, staging: persisted(second.state) });
  assert.equal(third.ready, true);
  assert.equal(asText(sandbox.backing.file), 'abcdefghij');
  assert.deepEqual(source.ranges, [[0, 3], [4, 7], [8, 9]]);
  assert.deepEqual(sandbox.backing.writes.map(write => write.chunk), ['abcd', 'efgh', 'ij']);
  assert.equal(sandbox.backing.starts, 1);
  assert.equal(sandbox.backing.restores, 1);

  const repeated = await stageFrozenInputs({ ...options, sandbox: restarted, staging: persisted(third.state) });
  assert.equal(repeated.ready, true);
  assert.deepEqual(source.ranges, [[0, 3], [4, 7], [8, 9]], 'a duplicate wake reads no bytes again');
  assert.equal(sandbox.backing.writes.length, 3);
});

test('a lost prepared container restarts placement at byte zero', async () => {
  const sandbox = stagingContainer();
  const source = placement();
  const options = { sandbox, bytes: asBytes('tool-tar'), placements: [source.input], chunk_bytes: 4 };
  const first = await stageFrozenInputs(options);
  sandbox.backing.running = false;
  sandbox.backing.file = new Uint8Array();
  const resumed = await stageFrozenInputs({ ...options, staging: persisted(first.state) });
  assert.equal(resumed.ready, false);
  assert.equal(resumed.state.files[0].offset, 4);
  assert.deepEqual(source.ranges, [[0, 3], [0, 3]]);
  assert.equal(sandbox.backing.starts, 2);
  assert.equal(asText(sandbox.backing.file), 'abcd');
});

test('a changed file identity cannot use the saved cursor', async () => {
  const sandbox = stagingContainer();
  const initial = placement();
  const first = await stageFrozenInputs({ sandbox, bytes: asBytes('tool-tar'), placements: [initial.input], chunk_bytes: 4 });
  const changed = placement(asBytes('abcdefghij'), 'different-identity');
  await assert.rejects(
    stageFrozenInputs({ sandbox, bytes: asBytes('tool-tar'), placements: [changed.input], staging: persisted(first.state), chunk_bytes: 4 }),
    /inputs changed/,
  );
  assert.equal(sandbox.backing.writes.length, 1);
});

for (const [name, returned] of [['short', asBytes('abc')], ['long', asBytes('abcdef')]]) {
  test(`a ${name} namespace range cannot advance the saved cursor`, async () => {
    const sandbox = stagingContainer();
    const input = {
      path: '/input/clip.mp4', identity: 'clip-identity', size: 4,
      open: async () => new Blob([returned]).stream(),
    };
    await assert.rejects(
      stageFrozenInputs({ sandbox, bytes: asBytes('tool-tar'), placements: [input], chunk_bytes: 4 }),
      /byte|length|range|size/i,
    );
  });
}
