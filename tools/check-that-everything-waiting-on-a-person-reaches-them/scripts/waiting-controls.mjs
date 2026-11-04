// scripts/waiting-controls.mjs
//
// PURPOSE
//   Checks, read-only, that every thing waiting on a person reaches them with a working control: for each card of
//   their Waiting on you answer, the control the hold and Home would give it (trillion-workshop tools/hold-one-thing-until-done/read-data/needs-you-hold.mjs `controlOf`), and
//   for a card done in a place in Trillion (`does_in`), that the place opens one of the workspace's screens
//   (src/workspace/addresses.mjs `placeOfAddress`) and that the screen, narrowed as the waiting screen narrows it,
//   draws something to press (an action, a switch, a field). Jibran 2026-10-07: "Sign in to Facebook once and allow
//   Trillion" was held with only a Checking spinner and no button, and every AI files these without checking.
//
//   node scripts/waiting-controls.mjs   (TRILLION_KEY: a key of the account; only GET reads are made)
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read-only: every request is a GET through the screen view's read (`screen_read`), the same answer the page reads.
//   2. Blind: nothing here names a kind of card, a screen or a service; screens are read through their own DATA.
//   3. Exits 1 when any card has no working control, listing each with why.
//

import settings from '../../keep-and-wake-ai-sessions-on-this-computer/src/waiting-on-you.json' with { type: 'json' };
import { controlOf } from '../../hold-one-thing-until-done/read-data/needs-you-hold.mjs';
import { placeOfAddress } from '../src/workspace/addresses.mjs';
import surfaces from '../src/workspace/screens.mjs';

/** Whether a screen's description draws anything to press: an action, a switch or a field, anywhere in it. */
export function pressable(description) {
  let found = false;
  const walk = value => {
    if (found || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if ((Array.isArray(value.actions) && value.actions.some(action => action && !action.disabled)) || value.switch || (Array.isArray(value.fields) && value.fields.length)) { found = true; return; }
    Object.values(value).forEach(walk);
  };
  walk(description?.sections ?? description);
  return found;
}

/**
 * Each waiting card with its control and whether it works: { id, title, control, works, why? }.
 * `readScreen(path)` answers a screen's description (GET /work/api/screens/<screen>?<query>) or null.
 */
export async function controlsOf(answer, readScreen, origin) {
  const opensScreen = address => placeOfAddress(surfaces.surfaces, address, origin) !== null;
  const rows = [];
  for (const section of answer?.sections ?? []) {
    for (const card of section.cards ?? []) {
      const control = controlOf({ finishes: answer.finishes ?? settings.finishes }, section, card, opensScreen);
      const row = { id: card.id, title: card.title ?? section.title, control: control?.kind ?? null };
      if (!control) { rows.push({ ...row, works: false, why: card.does_in ? `does_in ${card.does_in} opens no screen` : 'nothing to press, no place in Trillion, no steps' }); continue; }
      if (control.kind !== 'screen') { rows.push({ ...row, works: true }); continue; }
      const place = placeOfAddress(surfaces.surfaces, control.address, origin);
      const screen = typeof place?.input?.screen === 'string' ? place.input.screen : null;
      if (!screen) { rows.push({ ...row, works: true, why: `opens ${place.row.id}` }); continue; }
      const query = new URLSearchParams(Object.entries(place.input).filter(([name]) => name !== 'screen').map(([name, value]) => [name, String(value)]));
      const description = await readScreen(`/work/api/screens/${screen}${query.size ? `?${query}` : ''}`);
      const works = Boolean(description) && pressable(description);
      rows.push({ ...row, works, ...(works ? {} : { why: `${control.address} draws nothing to press` }) });
    }
  }
  return rows;
}

async function main() {
  const key = process.env.TRILLION_KEY;
  const origin = process.env.TRILLION_ORIGIN ?? 'https://app.gettrillion.ai';
  if (!key) throw new Error('Set TRILLION_KEY to a key of the account to check.');
  let id = 0;
  const read = async path => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'screen_read', arguments: { path, method: 'GET' } } }) });
      const text = await response.text();
      const line = text.includes('data:') ? text.split('\n').filter(item => item.startsWith('data:')).pop().slice(5) : text;
      const answer = JSON.parse(line || '{}').result?.structuredContent;
      if (answer?.status === 503) { await new Promise(done => setTimeout(done, 5000)); continue; }
      return answer?.status === 200 ? JSON.parse(answer.text) : null;
    }
    return null;
  };
  const answer = await read('/work/api/waiting-on-you');
  if (!answer) throw new Error('What waits could not be read.');
  const rows = await controlsOf(answer, read, origin);
  for (const row of rows) console.log(`${row.works ? 'ok  ' : 'NONE'} ${row.control ?? '-'}\t${row.id}\t${row.title}${row.why ? `\t(${row.why})` : ''}`);
  const broken = rows.filter(row => !row.works);
  console.log(`${rows.length} waiting, ${broken.length} with no working control`);
  if (broken.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
