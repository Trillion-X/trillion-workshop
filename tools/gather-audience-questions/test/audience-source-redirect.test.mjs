import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicAudiencePage } from '../src/audience-question-sources.mjs';

test('an observed quote cannot come from a different site than its recorded source', async () => {
  const redirect = location => async () => new Response(null, { status: 302, headers: { location } });
  await assert.rejects(
    () => readPublicAudiencePage('https://pottery.example/answer', {
      fetchPage: redirect('https://body.example/answer'),
    }),
    /different site/,
  );

  const visited = [];
  const page = await readPublicAudiencePage('https://pottery.example/old', {
    fetchPage: async url => {
      visited.push(url);
      return url.endsWith('/old')
        ? new Response(null, { status: 302, headers: { location: '/new' } })
        : new Response('What cue helps before a serve?', { headers: { 'content-type': 'text/plain' } });
    },
  });
  assert.equal(page, 'What cue helps before a serve?');
  assert.deepEqual(visited, ['https://pottery.example/old', 'https://pottery.example/new']);
});
