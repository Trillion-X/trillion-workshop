import { sqliteHost } from '../src/local-store.mjs';
import { recordLogStore } from '../parts/record-log/do-work/record-log-store.mjs';
import { eeafStore } from '../parts/eeaf/do-work/eeaf-sqlite-store.mjs';
import { eeafFieldReads } from '../parts/eeaf/do-work/eeaf-field-reads.mjs';

// Each named engine is constructed explicitly; no fixture label substitutes for it.
export function cursorFixture(engine) {
  const host = sqliteHost(':memory:');
  const open = () => {
    const records = engine === 'record-log'
      ? recordLogStore(host.sql, { transaction: host.transaction, indexes: [{ type: 'message', name: 'recorded_at', paths: [['recorded_at']] }], runs: { cache_bytes: 0, filter_bytes: 0, page_bytes: 4096 } })
      : eeafStore(host.sql, { transaction: host.transaction, hash: text => `members:${text}` });
    const fields = engine === 'record-log' ? records.fields : eeafFieldReads(host.sql, id => records.read(id));
    return { records, fields };
  };
  return { host, open };
}
export const CLOCK = Date.parse('2026-10-11T06:00:00.000Z');
export const TIME = new Date(CLOCK - 600_000).toISOString();
export const BEFORE = new Date(CLOCK - 1_200_000).toISOString();
export const message = (id, extra = {}) => ({ id, type: 'message', value: {
  recorded_at: TIME, app: 'Fixture AI', conversation_id: id, speaker: 'ai', text: `Answer for ${id}`, ...extra,
} });
