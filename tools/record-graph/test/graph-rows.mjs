// Made-up graph rows the read tools' tests hand in as `records`: what the person's AI would read from their store.
// Ids are the old relate's (relation:<hash of [subject, role, object]>), so the read tools see what relate keeps.
import { MODEL, textHash } from '../read-data/graph-records.mjs';

export const me = MODEL.relations.self;

/** One relation row; each end orders its links by its key (ties by id). */
export const relationRow = (subject, role, object, { alive = true, subjectOrder = 'V', objectOrder = 'V' } = {}) => ({
  id: `relation:${textHash(JSON.stringify([subject, role, object]))}`,
  type: 'relation',
  value: { subject, role, object, alive, subject_order: subjectOrder, object_order: objectOrder },
});

/** One activity row; `participants` are { record, role } (role participant when left out). */
export const activityRow = (name, kind, at, participants, extra = {}) => ({
  id: `activity:${name}`,
  type: 'activity',
  value: { kind, at: new Date(at).toISOString(), participants: participants.map(part => ({ role: 'participant', ...part })), ...extra },
});

const ann = 'record:crm:ann', bo = 'record:crm:bo', cy = 'record:crm:cy';
/** Four things that happened with me, Ann, Bo, Cy and an organisation. */
export const happenings = () => [
  activityRow('email-1', 'email', '2026-03-01T10:00:00Z', [{ record: me, role: 'sender' }, { record: ann, role: 'recipient' }], { summary: 'Sent the deck', direction: 'out' }),
  activityRow('call-1', 'call', '2026-04-02T09:00:00Z', [{ record: ann, role: 'caller' }, { record: me, role: 'recipient' }]),
  activityRow('meeting-1', 'meeting', '2026-05-03T15:00:00Z', [{ record: ann }, { record: bo }, { record: me }, { record: 'organisation:acme' }], { summary: 'Intro' }),
  activityRow('message-1', 'message', '2026-05-10T08:00:00Z', [{ record: cy, role: 'sender' }, { record: me, role: 'recipient' }]),
];
