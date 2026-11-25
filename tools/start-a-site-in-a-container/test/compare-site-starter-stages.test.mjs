// tools/start-a-site-in-a-container/test/compare-site-starter-stages.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSiteStarterStages, starterStage } from '../do-work/compare-site-starter-stages.mjs';

// A Dockerfile in the shape the sites carry: the pin, the starter stage, then the site's own stage.
const dockerfile = (commit, { tail = 'CMD ["node", "/opt/starter/start-with-engine-keys.mjs", "elestio/keys.json"]', check = 'RUN node check.mjs' } = {}) => [
  '# The starter has one owner.',
  `ARG STARTER_COMMIT=${commit}`,
  'ARG STARTER_BLAKE3=010fe21f813d4bc931600edbc5cab5899199a5a4271a3d485f476e3dea18b1d8',
  '',
  'FROM node:22-slim AS starter',
  'ARG STARTER_COMMIT',
  check,
  'RUN chmod 444 /starter/start-with-engine-keys.mjs',
  '',
  'FROM node:22-slim',
  'WORKDIR /app',
  tail,
].join('\n');
const NEW = '038fe313e11c74775e3587794772d3804aa29baa', OLD = 'c2afd75cccc7e633801076cb33f19f56e6541b02';

test('sites whose stages match are the same, whatever their own stages hold', () => {
  const answer = compareSiteStarterStages({ sites: [
    { site: 'a', dockerfile: dockerfile(NEW) },
    { site: 'b', dockerfile: dockerfile(NEW, { tail: 'CMD ["node", "other"]' }) },
  ] });
  assert.equal(answer.same, true);
  assert.equal(answer.stages, 1);
  assert.equal(answer.sites[0].stage, answer.sites[1].stage);
  assert.equal(answer.sites[0].starter_commit, NEW);
});

test('a site pinned to another starter commit, or with a changed stage line, is not the same', () => {
  const pinned = compareSiteStarterStages({ sites: [{ site: 'a', dockerfile: dockerfile(NEW) }, { site: 'b', dockerfile: dockerfile(OLD) }] });
  assert.equal(pinned.same, false);
  assert.equal(pinned.stages, 2);
  assert.deepEqual(pinned.sites.map(site => site.starter_commit), [NEW, OLD]);
  const changed = compareSiteStarterStages({ sites: [{ site: 'a', dockerfile: dockerfile(NEW) }, { site: 'b', dockerfile: dockerfile(NEW, { check: 'RUN true' }) }] });
  assert.equal(changed.same, false);
});

test('a site that still carries its own starter has no stage and does not count against the others', () => {
  const answer = compareSiteStarterStages({ sites: [
    { site: 'a', dockerfile: dockerfile(NEW) },
    { site: 'own', dockerfile: 'FROM node:22-slim\nCMD ["node", "elestio/start-with-engine-keys.mjs"]\n' },
  ] });
  assert.equal(answer.same, true);
  assert.deepEqual(answer.sites[1], { site: 'own', stage: null });
  assert.equal(starterStage('ARG STARTER_COMMIT=abc\nFROM node:22-slim\n'), null);
});
