// tools/form-groups-and-matches/read-data/console-selectors.mjs
//
// Pure selectors for a community's console. They turn the community's own DATA rows (member types, measures, per-day
// sequences, surfaces, programs, setup items, formed matches) into display models, with no domain word in the code.
//
//   - the permission matrix's columns are the union of the `permissions` strings in the member-type rows, in first-seen
//     order: a new permission string in DATA is a new column with no code change;
//   - a measure's title is its id's own tail, not a lookup table; the render layer chooses the copy;
//   - a program is summarized by which `*_ref` fields it carries, and its contents are never interpreted here.
//
// Invariants: pure (no I/O, no clock, no store); fail-soft (a malformed row is skipped, never thrown on); the row a model
// came from is kept on `row`, so a caller can write a change back as DATA. Enforcement stays with the owner of each
// fact: this module only edits or shows the authored rows.
import { readDailySequence } from './interaction-program-fold.mjs';

function isRecord(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/** Rows as the payloads themselves, whether they arrive bare or wrapped as `{ payload }`; anything else is dropped. */
export function normalizeRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => (isRecord(row) && isRecord(row.payload) ? row.payload : row))
    .filter(isRecord);
}

/**
 * The role-by-permission matrix. Columns are the union of every permission string in the rows, first-seen order.
 * Rows are the member-type rows that have a role, each with one boolean cell per column.
 */
export function buildRoleMatrix(memberTypeRows) {
  const rows = normalizeRows(memberTypeRows);
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const perm of asArray(row.permissions)) {
      if (typeof perm !== 'string' || perm.length === 0 || seen.has(perm)) continue;
      seen.add(perm);
      columns.push(perm);
    }
  }
  const matrixRows = rows
    .filter((row) => typeof row.role === 'string' && row.role.length > 0)
    .map((row) => {
      const granted = new Set(asArray(row.permissions).filter((p) => typeof p === 'string'));
      return {
        id: typeof row.id === 'string' ? row.id : row.role,
        role: row.role,
        community: typeof row.community === 'string' ? row.community : '',
        cells: columns.map((column) => ({ column, granted: granted.has(column) })),
        row,
      };
    });
  return { columns, rows: matrixRows };
}

/** Toggle one permission on a member-type row. Returns the new row payload; the given row is not changed. */
export function togglePermission(memberTypeRow, permission) {
  if (!isRecord(memberTypeRow) || typeof permission !== 'string' || permission.length === 0) {
    return memberTypeRow;
  }
  const current = asArray(memberTypeRow.permissions).filter((p) => typeof p === 'string');
  const has = current.includes(permission);
  const permissions = has ? current.filter((p) => p !== permission) : [...current, permission];
  return { ...memberTypeRow, permissions };
}

/** Measure rows as display models. The title is the row's own id tail with separators read as spaces. */
export function buildMeasureModels(measureRows) {
  return normalizeRows(measureRows)
    .filter((row) => typeof row.id === 'string' && row.id.length > 0)
    .map((row) => {
      const idTail = row.id.split(/[:.]/).filter(Boolean).pop() ?? row.id;
      return {
        id: row.id,
        title: idTail.replace(/[_-]+/g, ' '),
        emit: typeof row.emit === 'string' ? row.emit : '',
        failClosed: row.failClosed === true,
        row,
      };
    });
}

/** Daily-sequence rows as display models, each with its days in day order. */
export function buildSequenceModels(sequenceRows) {
  return normalizeRows(sequenceRows).flatMap((row) => {
    const model = readDailySequence(row);
    return model ? [{ ...model, row }] : [];
  });
}

/** Surface rows as display models. Page refs are opaque pointers: the console does not open them. */
export function buildSurfaceModels(surfaceRows) {
  return normalizeRows(surfaceRows)
    .filter((row) => typeof row.id === 'string' && row.id.length > 0)
    .map((row) => ({
      id: row.id,
      forProgram: typeof row.for_program === 'string' ? row.for_program : '',
      composeVia: typeof row.compose_via === 'string' ? row.compose_via : '',
      row,
    }));
}

/** Program rows as display models: the count of `*_ref` fields that carry a string. */
export function buildProgramModels(programRows) {
  return normalizeRows(programRows)
    .filter((row) => typeof row.id === 'string' && row.id.length > 0)
    .map((row) => ({
      id: row.id,
      refCount: Object.keys(row).filter((k) => k.endsWith('_ref') && typeof row[k] === 'string' && row[k].length > 0).length,
      row,
    }));
}

/**
 * Setup items (self-described by name, type and purpose) as display models. Rendered generically: a new item type needs
 * no code change, so there is no branch per type.
 */
export function buildSetupModels(setupRows) {
  return normalizeRows(setupRows)
    .filter((row) => typeof row.id === 'string' && row.id.length > 0)
    .map((row) => ({
      id: row.id,
      name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id.replace(/[_-]+/g, ' '),
      type: typeof row.type === 'string' && row.type.length > 0 ? row.type : 'item',
      purpose: typeof row.purpose === 'string' ? row.purpose : '',
      row,
    }));
}

/**
 * Formed matches (connection rows) as display models. The members come from `members`, or from `source` and `target`;
 * the score and rationale come from the row's own `attributes`, so a different scorer renders with no code change.
 */
export function buildMatchModels(matchRows) {
  return normalizeRows(matchRows)
    .filter((row) => typeof row.id === 'string' && row.id.length > 0)
    .map((row) => {
      const attrs = row.attributes && typeof row.attributes === 'object' ? row.attributes : {};
      const members = Array.isArray(row.members) && row.members.length > 0
        ? row.members.filter((m) => typeof m === 'string' && m.length > 0)
        : [row.source, row.target].filter((m) => typeof m === 'string' && m.length > 0);
      return {
        id: row.id,
        members,
        program: typeof attrs.program_id === 'string' ? attrs.program_id : '',
        score: typeof attrs.match_score === 'number' ? attrs.match_score : null,
        rationale: typeof attrs.match_rationale === 'string' ? attrs.match_rationale : '',
        row,
      };
    });
}
