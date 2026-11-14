// packages/interaction-program/read-data/console-selectors.mjs
//
// =============================================================================
// PURPOSE — pure selectors for the Community console (T5–T8 CM config surface)
// =============================================================================
//
// The console renders ONLY what the DATA rows describe. These selectors turn the
// scoped-feed rows (member-type / measure-definition / daily-sequence / surface /
// interaction-program) into display models with ZERO hardcoded domain knowledge:
//
//   - permission MATRIX columns = the UNION of `permissions[]` strings found in
//     the member-type rows (a new permission string in DATA = a new column,
//     zero code — L063/L090; never a closed permission list)
//   - member-type rows → matrix rows keyed by role
//   - measure-definition rows → human display models (no op/window vocabulary
//     leaks; the RENDER layer chooses copy)
//
// Deletion test: feed a completely different community's rows (novel roles,
// novel permission strings) → the same selectors produce a working model with
// zero code change. Proven in console-selectors.test.mjs.
//
// NON-NEGOTIABLE INVARIANTS:
// 1. No hardcoded role names, permission names, community names, or kind
//    branching beyond the row's self-described fields (L090).
// 2. Pure functions — no I/O, no engine access; testable without a runtime.
// 3. Fail-soft: malformed rows are skipped, never thrown on.
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

function isRecord(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Feed rows may arrive as the payload array directly or wrapped per-row; accept
 * both (mirrors normalize conventions in the funnel mount).
 */
export function normalizeRows(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => (isRecord(row) && isRecord(row.payload) ? row.payload : row))
    .filter(isRecord);
}

/**
 * The role×permission matrix model.
 * Columns = UNION of every permission string present in the rows, in first-seen
 * order (stable for the UI, entirely DATA-derived). Rows = one per member-type
 * row, each with a per-column boolean.
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
    .map((row) => ({
      id: typeof row.id === 'string' ? row.id : row.role,
      role: row.role,
      community: typeof row.community === 'string' ? row.community : '',
      granted: new Set(asArray(row.permissions).filter((p) => typeof p === 'string')),
      row,
    }))
    .map((entry) => ({
      id: entry.id,
      role: entry.role,
      community: entry.community,
      cells: columns.map((column) => ({ column, granted: entry.granted.has(column) })),
      row: entry.row,
    }));
  return { columns, rows: matrixRows };
}

/**
 * Toggle one permission on a member-type row → the NEW row payload (immutable).
 * The caller writes it back as DATA; no evaluation logic here (access-rule owns
 * enforcement — this only edits the authored DATA row).
 */
export function togglePermission(memberTypeRow, permission) {
  if (!isRecord(memberTypeRow) || typeof permission !== 'string' || permission.length === 0) {
    return memberTypeRow;
  }
  const current = asArray(memberTypeRow.permissions).filter((p) => typeof p === 'string');
  const has = current.includes(permission);
  const permissions = has ? current.filter((p) => p !== permission) : [...current, permission];
  return { ...memberTypeRow, permissions };
}

/**
 * Measure rows → display models. `title` derives from the row's own id tail (a
 * data-owned name), never from a lookup table.
 */
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

/**
 * Daily-sequence rows → display models (days sorted by their own `day` number).
 */
export function buildSequenceModels(sequenceRows) {
  return normalizeRows(sequenceRows)
    .filter((row) => typeof row.id === 'string' && row.id.length > 0)
    .map((row) => ({
      id: row.id,
      forProgram: typeof row.for_program === 'string' ? row.for_program : '',
      days: asArray(row.days)
        .filter(isRecord)
        .slice()
        .sort((a, b) => (Number(a.day) || 0) - (Number(b.day) || 0))
        .map((d) => ({
          day: Number(d.day) || 0,
          title: typeof d.title === 'string' ? d.title : '',
          prompt: typeof d.prompt_text === 'string' ? d.prompt_text : '',
        })),
      row,
    }));
}

/**
 * Program-surface rows → display models (page refs are opaque data pointers).
 */
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

/**
 * Interaction-program rows → display models (the 10-ref descriptor summarized
 * by which refs are present — the console never interprets ref contents).
 */
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
 * The AI-configured "Community setup" items (kind: interaction-program.setup-item),
 * produced by Ask-AI and applied as live records. Rendered generically by their
 * self-describing name/type/purpose (L090/L118) — never a per-type branch, so a new
 * descriptor type (channel, ritual, role, access-rule, schedule, page, …) needs ZERO
 * code change.
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
 * Formed matches (relationship-graph `connection` records) → display models. The
 * matchmaker writes each pairing as a connection whose self-describing fields
 * (members, attributes.match_score / program_id / rationale) drive the render — no
 * per-program branch (L090). The score/rationale ride the record's own provenance, so
 * a different scorer (LLM rationale, pure cosine, …) renders with zero code change.
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
