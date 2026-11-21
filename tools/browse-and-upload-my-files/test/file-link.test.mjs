// A link to one file is made by share_file with the file's identity and the DATA length, and its address is checked
// before the sheet shows it. The files door is a stand-in that records what it was asked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFileLink } from '../web/src/workspace/file-link.mjs';

const standIn = answer => {
  const calls = [];
  const change = async (op, input) => {
    calls.push({ op, input });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { change, calls };
};

test('the link is made by share_file for the file identity, for the seconds given', async () => {
  const door = standIn({ url: 'https://app.example.com/share/abc/shr_key', share: 'abc', expires_at: '2026-11-22T10:00:00.000Z' });
  const link = await makeFileLink(door.change, { identity: 'id-A', seconds: 86400 });
  assert.deepEqual(door.calls, [{ op: 'share_file', input: { name_or_identity: 'id-A', seconds: 86400 } }]);
  assert.deepEqual(link, { url: 'https://app.example.com/share/abc/shr_key', expires_at: '2026-11-22T10:00:00.000Z' });
});

test('an answer without an https address is refused, so the sheet never shows a bad link', async () => {
  await assert.rejects(makeFileLink(standIn({ url: 'http://insecure.example/share/x' }).change, { identity: 'id-A', seconds: 60 }), /no address/);
  await assert.rejects(makeFileLink(standIn({}).change, { identity: 'id-A', seconds: 60 }), /no address/);
});

test('a file with no identity is refused before anything is asked', async () => {
  const door = standIn({ url: 'https://x.example/share/a' });
  await assert.rejects(makeFileLink(door.change, { identity: '  ', seconds: 60 }), /A file is needed/);
  assert.deepEqual(door.calls, []);
});

test('a refusal from the files door reaches the caller', async () => {
  await assert.rejects(makeFileLink(standIn(new Error('seconds must be 1 up to 604800')).change, { identity: 'id-A', seconds: 0 }), /seconds must be/);
});
