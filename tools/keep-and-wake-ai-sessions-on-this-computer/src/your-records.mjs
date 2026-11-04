// A person's own records that shared Workshop tools read and keep (src/workshop.mjs `records`): customers, the steps
// taken with them, targets, anything a tool's row names by type. They live in the person's EEAF store beside their
// decisions and pursuits, each under the type `record:<type>` and the id `record:<type>:<id>`, so a tool can reach
// only these and never a decision, a pursuit, a setting or a payment, whatever type its output names. A record kept
// again under the same type and id replaces the earlier one, whose values stay in the EEAF log.
// Public app definitions declare generic record kinds too; keep their existing
// dotted and underscored names usable through the same records and rules APIs.
import { CONFIGURATION_TYPE, makeConfigurations } from './configurations.mjs';

const TYPE = /^[a-z][a-z0-9._-]{1,99}$/;
const LIMITS = { types_per_read: 20, records_per_write: 200, id_chars: 200 };
// The most records one tool input is filled with (src/workshop.mjs yourRecords). An account keeps any number; a tool
// is handed at most this many, and above it the caller is told to send the records it means instead of a cut list.
export const RECORDS_PER_TOOL_INPUT = 1000;

export class TooManyRecords extends Error {
  constructor(types, at_most) {
    super(`This account keeps more than ${at_most} ${types.join(', ')} records, the most one read hands on.`);
    Object.assign(this, { at_most });
  }
}

export function yourRecordsStore(eeaf, { configurationOwner = scope => makeConfigurations(scope) } = {}) {
  const typeOf = type => {
    if (typeof type !== 'string' || !TYPE.test(type)) throw new Error(`A record type is a short name in lower case letters, digits and dashes, like "customer-step"; ${JSON.stringify(type)} is not one.`);
    return `record:${type}`;
  };
  const readAtMost = (types, at_most) => {
    const ids = [];
    for (const type of types) {
      ids.push(...eeaf.ids(typeOf(type), { limit: at_most + 1 - ids.length }));
      if (ids.length > at_most) throw new TooManyRecords(types, at_most);
    }
    return ids.map(id => eeaf.read(id)).filter(value => value !== null);
  };
  return {
    // Every current record of each named type, in id order within each type. With `at_most`, at most one id past it is
    // listed and more than that many is refused before any record is read, so a reader that hands records on never
    // hands on a silently cut list and never lists every id to find out.
    read(types, { at_most = null } = {}) {
      if (!Array.isArray(types) || !types.length || types.length > LIMITS.types_per_read) throw new Error(`Name between 1 and ${LIMITS.types_per_read} record types to read.`);
      if (at_most !== null) return readAtMost(types, at_most);
      return types.flatMap(type => eeaf.ids(typeOf(type)).map(id => eeaf.read(id)).filter(value => value !== null));
    },
    // Keeps each { type, id, value } in one transaction; answers the type and id of each record kept.
    write(records, { tool_id = null, task_id = null } = {}) {
      if (!Array.isArray(records) || records.length > LIMITS.records_per_write) throw new Error(`Keep at most ${LIMITS.records_per_write} records at a time.`);
      const rows = records.map(({ type, id, value }) => {
        if (typeof id !== 'string' || !id.trim() || id.length > LIMITS.id_chars || id.includes('/')) throw new Error(`Each record needs its own id (text of at most ${LIMITS.id_chars} characters, without "/"); a ${type} record has ${JSON.stringify(id)}.`);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`The ${type} record ${id} is not an object.`);
        return { id: `${typeOf(type)}:${id}`, type: typeOf(type), value };
      });
      const context = { actor: { by: tool_id ?? 'a tool', ...(task_id ? { task_id } : {}) } };
      if (rows.some(row => row.type === CONFIGURATION_TYPE)) {
        // Workshop outputs use the same configuration owner as the UI and API.
        // Stage every row before committing once: a stale configuration must
        // not leave an earlier generic record (or configuration) half-written.
        const staged = new Map(), writes = [];
        const stage = changes => {
          for (const change of changes) { staged.set(change.id, change.value); writes.push(change); }
        };
        const configurations = configurationOwner({
          eeaf: { ...eeaf, read: id => staged.has(id) ? staged.get(id) : eeaf.read(id) },
          writeMutation: stage,
        });
        for (const row of rows) {
          if (row.type !== CONFIGURATION_TYPE) { stage([row]); continue; }
          // The output's identity is the declared row identity. Owner, revision,
          // timestamps and other returned metadata are never caller-writable.
          // Existing rows require explicit expected_revision; `revision` alone
          // cannot turn a blind replacement into an admitted edit.
          const fields = ['label', 'target', 'format', 'settings', 'aspects', 'field_ids', 'open_path', 'copied_from', 'expected_revision'];
          const input = Object.fromEntries(fields.filter(field => Object.hasOwn(row.value, field)).map(field => [field, row.value[field]]));
          configurations.save({ ...input, id: row.id }, context);
        }
        if (writes.length) eeaf.write(writes, context);
      } else if (rows.length) eeaf.write(rows, context);
      return records.map(({ type, id }) => ({ type, id }));
    },
  };
}
