// tools/carry-a-computer-to-a-meeting-point/test/a-silent-link-ends-at-both-ends.test.mjs
//
// A link that goes silent (a phone hotspot dropping) ends at both ends within about 30 s: the client's keepalive ends its
// side, and the meeting point's sshd ends the dead session, so the port it held is free for the computer's next try.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WAYS, renderMeetingPoint } from '../do-work/carry-a-computer.mjs';

const way = WAYS.find(row => row.id === 'ssh-certificate');
const seconds = (words, interval, count) => Number(words.match(new RegExp(`${interval}[ =](\\d+)`))?.[1]) * Number(words.match(new RegExp(`${count}[ =](\\d+)`))?.[1]);

test('the client ends a silent link within 30 s', () => {
  assert.ok(seconds(way.client.argv.join(' '), 'ServerAliveInterval', 'ServerAliveCountMax') <= 30);
});

test('the meeting point ends a dead session within 30 s, inside the carry user\'s own block', () => {
  const { steps } = renderMeetingPoint({ way, relay_host: { hostname: 'meeting.example.test' }, computers: [], values: { ca_public_file: '/ca.pub', port_min: '20000', port_max: '59999' } });
  const text = steps.find(step => step.file?.path?.endsWith('.conf')).file.text;
  assert.match(text, /^Match User /);
  assert.ok(seconds(text, 'ClientAliveInterval', 'ClientAliveCountMax') <= 30);
});
