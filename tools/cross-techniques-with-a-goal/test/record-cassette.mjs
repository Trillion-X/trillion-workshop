// tools/cross-techniques-with-a-goal/test/record-cassette.mjs
//
// Purpose
//   Records what the live writer model answers when the cross-medium fixture is crossed with its goal, so the test
//   replays real model output without a model server: every answer by its call's name. One JSON request on standard
//   input ({ models: { writing }, fixture?, cassette? }); writes the cassette and prints { result: { written, lines } }.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { readFileSync, writeFileSync } from 'node:fs';
import { writer } from '../do-work/meaning.mjs';
import { crossTechniquesWithAGoal } from '../do-work/cross.mjs';

const read = url => JSON.parse(readFileSync(url, 'utf8'));
const request = JSON.parse(readFileSync(0, 'utf8'));
const fixtureUrl = new URL(request.fixture ?? './fixtures/cross-medium.json', import.meta.url);
const cassetteUrl = new URL(request.cassette ?? './fixtures/cross-medium-cassette.json', import.meta.url);
const conventions = read(new URL('../do-work/technique-conventions.json', import.meta.url));
const fixture = read(fixtureUrl);

const live = writer(request.models.writing);
const written = {};
const write = async call => {
  const answer = await live(call);
  written[call.name] = answer;
  return answer;
};

const result = await crossTechniquesWithAGoal({ ...fixture.request, rows: fixture.rows, vocabulary: fixture.vocabulary, models: { write } }, conventions);
writeFileSync(cassetteUrl, `${JSON.stringify({ writer: request.models.writing.model, recorded: new Date().toISOString().slice(0, 10), written }, null, 1)}\n`);
console.log(JSON.stringify({ result: { written: Object.keys(written), lines: result.lines } }));
