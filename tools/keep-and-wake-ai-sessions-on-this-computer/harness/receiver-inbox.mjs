import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const safeId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) throw new Error('Invalid event ID.');
  return value;
};

// A 202 from the receiver means the signed event is on disk, not that its work is finished.
export function receiverInbox(folder) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const pathOf = id => join(folder, `${safeId(id)}.json`);
  const read = id => { try { return JSON.parse(readFileSync(pathOf(id), 'utf8')); } catch { return null; } };
  const save = (id, value) => {
    const path = pathOf(id);
    const part = `${path}.part`;
    writeFileSync(part, JSON.stringify(value), { mode: 0o600 });
    renameSync(part, path);
  };
  return {
    accept(id, event) {
      const previous = read(id);
      if (previous) return previous;
      const entry = { event, state: 'pending' };
      save(id, entry);
      return entry;
    },
    done(id) { const entry = read(id); if (entry) save(id, { ...entry, state: 'done' }); },
    // An event this receiver can never act on (work for another chat, a check addressed elsewhere) is settled with its
    // reason and never replayed: replaying it only reads the account again and again for nothing.
    refused(id, reason) { const entry = read(id); if (entry) save(id, { ...entry, state: 'refused', reason }); },
    woke(id, wake) { const entry = read(id); if (entry) save(id, { ...entry, wake }); },
    pending() {
      return readdirSync(folder).filter(name => /^[A-Za-z0-9_-]{1,200}\.json$/.test(name))
        .map(name => [name.slice(0, -5), read(name.slice(0, -5))])
        .filter(([, entry]) => entry?.state === 'pending');
    },
    read,
  };
}
