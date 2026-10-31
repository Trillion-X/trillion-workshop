// tools/published-destinations/read-data/check-honest-state.mjs
//
// Whether a destination descriptor is honest to publish before its owner has produced any numbers: its labels and
// definitions may be filled in, but every value the owner has to work out (a bar, a stat, a percent, a rank, who did
// it) must start empty and arrive later from the owner's own output. A descriptor that ships made-up values would show
// a person progress they never made.
//
// The problems are reported, all of them, not thrown: finding them is the job. `presentation` is an open key and is
// never compared against a list.

const OWNER_WORKED_OUT_ITEM_KEYS = ['actor', 'rank', 'percent', 'fraction', 'celebrate'];
const OWNER_WORKED_OUT_SECTION_KEYS = ['percent', 'ring_label', 'ringLabel'];
const MAX_SECTIONS = 64;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function filled(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function containsKey(value, key) {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([entryKey, entryValue]) => entryKey === key || containsKey(entryValue, key));
}

/**
 * Every reason the descriptor is not honest, in words. `refuseKeys` are keys the person's own rules say may not
 * appear anywhere in it (for example, instructions a screen could use to write results itself); none by default.
 */
export function honestStateProblems(descriptor, { refuseKeys = [] } = {}) {
  if (!isRecord(descriptor) || descriptor.kind !== 'destination-descriptor') {
    return ['it is not a destination descriptor (kind must be "destination-descriptor")'];
  }
  const problems = [];
  if (!filled(descriptor.ref)) problems.push('ref is required');
  if (!filled(descriptor.subject_ref)) problems.push('subject_ref is required: the descriptor is for one subject');
  if (!filled(descriptor.statement)) problems.push('statement is required');
  for (const key of refuseKeys) {
    if (containsKey(descriptor, key)) problems.push(`it contains the refused key "${key}"`);
  }
  if (!Array.isArray(descriptor.sections) || descriptor.sections.length === 0 || descriptor.sections.length > MAX_SECTIONS) {
    problems.push(`sections must hold 1 to ${MAX_SECTIONS} sections`);
    return problems;
  }
  descriptor.sections.forEach((section, index) => {
    const where = `section ${index + 1}`;
    if (!isRecord(section)) {
      problems.push(`${where} is not an object`);
      return;
    }
    if (!filled(section.presentation)) problems.push(`${where} has no presentation`);
    if (Array.isArray(section.bars) && section.bars.length > 0) {
      problems.push(`${where}: bars must start empty and come from the owner's output`);
    }
    if (Array.isArray(section.stats) && section.stats.length > 0) {
      problems.push(`${where}: stats must start empty and come from the owner's output`);
    }
    for (const key of OWNER_WORKED_OUT_SECTION_KEYS) {
      if (key in section) problems.push(`${where}: "${key}" must start empty and come from the owner's output`);
    }
    const items = Array.isArray(section.items) ? section.items : [];
    items.forEach((item, itemIndex) => {
      if (!isRecord(item)) {
        problems.push(`${where}, item ${itemIndex + 1} is not an object`);
        return;
      }
      for (const key of OWNER_WORKED_OUT_ITEM_KEYS) {
        if (key in item) problems.push(`${where}, item ${itemIndex + 1}: "${key}" must start empty and come from the owner's output`);
      }
    });
  });
  return problems;
}
