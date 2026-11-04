// src/own-ais-apps.mjs
//
// The person's AIs grouped by the AI app they connected: one app row (Claude Code, Codex, ChatGPT, Claude) with its
// sessions and agents under it as instances, each instance saying where it runs. Pure: rows in, groups out.
//
// Purpose
//   The AI records (src/ais.mjs) are one per thing that published a card or signed in: a session of an app, an agent on
//   a computer, a legacy row. Listed one by one they read as dozens of AIs. The person's AIs are the apps; a session or
//   agent of an app is an instance of it; the computer it runs on is where it runs, never the AI's name.
//
// Non-negotiable invariants
//   1. An app is named by DATA (src/harnesses.json): a row's label or key is matched by harnessWithin, nothing here
//      names an app. A row no app row names is "other" and joins that one group only while it is live.
//   2. Every row of a named app is an instance of it, live or not, so a handoff to one agent_id stays addressable. An
//      unnamed row that is not live is in no group (it is still in the rows list the caller returns).
//   3. Liveness is liveProblem (src/own-ais.mjs), the same test the routing uses; one app is live when any instance is.
//   4. The order of the groups is the person's order: the lowest order among an app's instances.
import { harnessWithin } from '../../keep-and-wake-ai-sessions-on-this-computer/src/harnesses.mjs';
import { liveProblem } from '../../shared-code/src/own-ais.mjs';
import aisData from '../../shared-code/src/ais.json' with { type: 'json' };

const OTHER = 'other';

/** The computer an instance runs on (its runs_on.device without the record prefix), or null for a chat. */
export function whereOf(row) {
  const device = row?.runs_on?.device;
  return typeof device === 'string' && device.trim() ? device.trim().replace(/^device:/, '') : null;
}

/**
 * The app row a record belongs to (src/harnesses.json), else null. A computer's card is named "<app> on <computer>"
 * (harness/take-open-work.json agent_name), so only the words before " on " name its app, never the computer; its key
 * carries the computer too, so it is not read. Any other record is named by its label, then its key (a chat's key is
 * the app its card named).
 */
export function appOfRow(row) {
  const label = typeof row?.label === 'string' ? row.label : '';
  if (whereOf(row)) return harnessWithin(label.split(' on ')[0]);
  for (const text of [label, row?.key]) {
    const harness = text ? harnessWithin(String(text)) : null;
    if (harness) return harness;
  }
  return null;
}

/**
 * The groups of the person's AI rows: [{ id, app, label, live_now, trouble, order, instances: [{ id, agent_id, label,
 * kind, where, live_now, problem, order }] }], live apps first, then the person's order. `words` is src/ais.json screen.
 */
export function appsOf(rows, { now = new Date(), words = aisData.screen } = {}) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const harness = appOfRow(row);
    const problem = liveProblem(row, now);
    const live = problem === null;
    if (!harness && !live) continue;
    const id = harness ? harness.id : OTHER;
    if (!groups.has(id)) groups.set(id, { id, app: harness ? harness.app : null, label: harness ? harness.app : words.other_apps, instances: [] });
    groups.get(id).instances.push({
      id: row.id, agent_id: row.agent_id ?? null, label: row.label ?? row.key ?? row.id, kind: row.kind ?? null,
      where: whereOf(row), live_now: live, problem, order: Number.isFinite(row.order) ? row.order : (aisData.order_default ?? 100),
      trouble: typeof row.live?.trouble === 'string' ? row.live.trouble : row.live?.trouble?.why ?? null,
      seen_at: row.live?.seen_at ?? null,
    });
  }
  return [...groups.values()].map(group => {
    const instances = group.instances.sort((a, b) => Number(b.live_now) - Number(a.live_now) || a.order - b.order || String(a.label).localeCompare(String(b.label)));
    const recent = [...instances].sort((a, b) => Date.parse(b.seen_at ?? '') - Date.parse(a.seen_at ?? '') || 0)[0];
    return {
      id: group.id, app: group.app, label: group.label, live_now: instances.some(item => item.live_now),
      trouble: instances.some(item => item.live_now) ? null : (recent?.trouble ?? null),
      order: Math.min(...instances.map(item => item.order)), instances,
    };
  }).sort((a, b) => Number(b.live_now) - Number(a.live_now) || a.order - b.order || String(a.label).localeCompare(String(b.label)));
}
