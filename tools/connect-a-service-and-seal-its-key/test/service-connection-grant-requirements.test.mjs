import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import { evaluateGrantRequirement } from '../read-data/grant-requirements.ts';
import { asServiceCapability } from '../read-data/read-service-connection-options.ts';

const status = (alternatives, grants, known = true) =>
  evaluateGrantRequirement(alternatives, grants, known).status;

test('any complete alternative satisfies the declaration; scopes within one alternative are conjunctive', () => {
  assert.equal(status([['mail.read'], ['mail.read', 'mail.write']], ['mail.read']), 'satisfied');
  assert.equal(status([['mail.read', 'mail.write'], ['mail.send']], ['mail.read', 'mail.send']), 'satisfied');
  assert.equal(status([['mail.read', 'mail.write'], ['mail.send']], ['mail.read']), 'missing');
});

test('unknown grants stay unknown while a reported empty grant list is authoritative', () => {
  const requirement = [['mail.read']];
  assert.equal(status(requirement, undefined, false), 'unknown');
  assert.equal(status(requirement, [], false), 'unknown');
  assert.equal(status(requirement, [], true), 'missing');
  assert.equal(status([[]], ['mail.read'], true), 'unknown');
});

test('duplicate scopes do not change the result', () => {
  assert.equal(status([['mail.read', 'mail.read', 'mail.write']], ['mail.read', 'mail.write', 'mail.read']), 'satisfied');
  assert.deepEqual(asServiceCapability({
    id: 'mail', label: 'Mail',
    required_scope_alternatives_by_tool: { 'tool:read': [['mail.read', 'mail.read']] },
  })?.requiredScopeAlternativesByTool, { 'tool:read': [['mail.read']] });
});

test('malformed DATA is omitted by the parser and cannot become a false success', () => {
  for (const malformed of [
    null,
    [],
    { 'tool:read': [] },
    { 'tool:read': [[]] },
    { 'tool:read': [['mail.read', ' ']] },
    { 'tool:read': 'mail.read' },
  ]) {
    const capability = asServiceCapability({
      id: 'mail', label: 'Mail',
      required_scope_alternatives_by_tool: malformed,
    });
    assert.equal(capability?.requiredScopeAlternativesByTool, undefined);
    assert.equal(status(capability?.requiredScopeAlternativesByTool?.['tool:read'], ['mail.read'], true), 'unknown');
  }
});

test('evaluator treats malformed grants and malformed alternatives conservatively', () => {
  assert.equal(status([['mail.read']], ['mail.read', 3], true), 'unknown');
  assert.equal(status([['mail.read'], []], ['mail.read'], true), 'unknown');
  assert.equal(status(undefined, ['mail.read'], true), 'unknown');
});

test('the shipped Calendar request includes Calendar List access and keeps broader reported grants valid', () => {
  const data = JSON.parse(readFileSync(new URL(import.meta.resolve('../records.json')), 'utf8'));
  const calendar = data.things.find(row => row.payload?.vendor === 'google-calendar').payload;
  const capability = asServiceCapability(calendar.capabilities[0]);
  const requirement = capability.requiredScopeAlternativesByTool['tool:google-calendar-list_calendars'];
  const prefix = 'https://www.googleapis.com/auth/';
  assert.equal(status(requirement, calendar.acquire.scopes), 'satisfied');
  assert.equal(status(requirement, ['calendar.events', 'calendar.freebusy', 'calendar.calendars.readonly'].map(value => prefix + value)), 'missing');
  assert.equal(status(requirement, [prefix + 'calendar.readonly']), 'satisfied');
  assert.equal(status(requirement, [prefix + 'calendar']), 'satisfied');
  assert.equal(status(requirement, [], false), 'unknown');
  const colors = capability.requiredScopeAlternativesByTool['tool:google-calendar-list_colors'];
  assert.equal(status(colors, calendar.acquire.scopes), 'satisfied');
});


test('Gmail action requirements preserve metadata, search, draft and settings distinctions without requesting new grants', () => {
  const data = JSON.parse(readFileSync(new URL(import.meta.resolve('../records.json')), 'utf8'));
  const gmail = data.things.find(row => row.payload?.vendor === 'google-account').payload;
  const capability = asServiceCapability(gmail.capabilities[0]);
  const requirements = capability.requiredScopeAlternativesByTool;
  assert.deepEqual(Object.keys(requirements).sort(), [...capability.toolIds].sort());
  const prefix = 'https://www.googleapis.com/auth/';
  for (const requirement of Object.values(requirements)) {
    assert.equal(status(requirement, gmail.acquire.scopes), 'satisfied');
    assert.equal(status(requirement, [], false), 'unknown');
    assert.equal(status(requirement, []), 'missing');
  }
  assert.equal(status(requirements['tool:read-mail-headers'], [prefix + 'gmail.metadata']), 'satisfied');
  assert.equal(status(requirements['tool:read-a-mail'], [prefix + 'gmail.metadata']), 'missing');
  assert.equal(status(requirements['tool:find-mail'], [prefix + 'gmail.metadata']), 'missing');
  assert.equal(status(requirements['tool:send-a-mail-draft'], [prefix + 'gmail.send']), 'missing');
  assert.equal(status(requirements['tool:send-a-mail-draft'], [prefix + 'gmail.compose']), 'satisfied');
  assert.equal(status(requirements['tool:set-a-mail-signature'], [prefix + 'gmail.modify']), 'missing');
  assert.equal(status(requirements['tool:set-a-mail-signature'], [prefix + 'gmail.settings.basic']), 'satisfied');
});
