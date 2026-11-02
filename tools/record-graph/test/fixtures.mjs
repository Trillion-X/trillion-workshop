// Made-up records the record-graph tests share.
import { relate } from '../do-work/relate.mjs';

const ann = 'record:crm:ann', bo = 'record:crm:bo', cy = 'record:crm:cy';
/** Four things that happened with me, Ann, Bo, Cy and an organisation. */
export const seedActivities = door => relate(door, { activities: [
  { kind: 'email', at: '2026-03-01T10:00:00Z', summary: 'Sent the deck', direction: 'out', participants: [{ record: 'me', role: 'sender' }, { record: ann, role: 'recipient' }] },
  { kind: 'call', at: '2026-04-02T09:00:00Z', participants: [{ record: ann, role: 'caller' }, { record: 'me', role: 'recipient' }] },
  { kind: 'meeting', at: '2026-05-03T15:00:00Z', summary: 'Intro', participants: [{ record: ann }, { record: bo }, { record: 'me' }, { record: 'organisation:Acme' }] },
  { kind: 'message', at: '2026-05-10T08:00:00Z', participants: [{ record: cy, role: 'sender' }, { record: 'me', role: 'recipient' }] },
] });
