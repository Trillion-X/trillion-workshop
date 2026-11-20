// Ported from the retired repository test/gemini-connect.test.mjs (b6ae0ebf81): the assertions are unchanged, only the import paths are.
// Gemini on the connect screen: the web app adds the product as a custom app (Google's "Connect & manage custom apps for
// Gemini Apps", support.google.com/gemini/answer/17209137, read 2026-09-30) and the terminal adds it with the Gemini
// CLI. Both rows are DATA in src/ai-clients.json, and picking either tab copies the one focused setup message.
import test from 'node:test';
import assert from 'node:assert/strict';
import clients from '../read-data/ai-clients.json' with { type: 'json' };
import { aiAppGuides, appSteps } from '../read-data/ai-app-guides.mjs';

const row = id => clients.clients.find(client => client.id === id);

test('the Gemini web app row follows Google\'s own steps and says who can use it', () => {
  const gemini = row('gemini');
  assert.equal(gemini.domain, 'gemini.google.com');
  for (const words of [/18 or over/, /in the US/, /personal Google Account/, /Work and school/]) assert.match(gemini.lead, words);
  const said = appSteps(gemini).map(step => [step.title, step.body, step.leave, step.fix].join(' ')).join(' ');
  for (const words of [/Settings, then Connected Apps/, /Personal Intelligence/, /Add a custom app/, /Keep Activity/, /type @ and pick /]) assert.match(said, words);
  assert.ok(appSteps(gemini).some(step => step.code === '{mcp}'), 'one step pastes the MCP address');
});

test('the Gemini CLI tab names its command and the setup text stays one focused message, and no row says the web app cannot add it', () => {
  assert.match(appSteps(row('gemini-cli'))[0].code, /^gemini mcp add --transport http \S+ \{mcp\}$/);
  const guides = aiAppGuides('https://app.test');
  const tab = id => guides.tabs.find(item => item.id === id);
  assert.ok(tab('gemini-cli').steps.some(step => /^gemini mcp add --transport http \S+ https:\/\/app\.test\/mcp$/.test(step.code)));
  assert.match(tab('gemini').steps[0].title, /Connected Apps/);
  // Picking the Gemini tabs copies the same focused setup message, filled with this service's address.
  for (const id of ['gemini', 'gemini-cli']) assert.ok(tab(id).copy.text.includes('https://app.test/mcp'), id);
  assert.doesNotMatch(JSON.stringify(clients.clients), /does not currently document a way to add a custom MCP server/);
});
