// A bounded measure is a share of named units, never an estimate from a status word.
// Keep the source units beside the percentage so a reader can see its denominator.
function countWords(measure) {
  const done = measure?.done;
  const total = measure?.total;
  if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total) || total < 1 || done < 0 || done > total) return null;
  const many = typeof measure.unit === 'string' && measure.unit.trim() ? measure.unit.trim() : 'steps';
  const unit = total === 1 && typeof measure.unit_one === 'string' && measure.unit_one.trim() ? measure.unit_one.trim() : many;
  return `${done} of ${total} ${unit} finished`;
}

export function progressWords(measure) {
  const count = countWords(measure);
  return count ? `${count} (${Math.round(100 * measure.done / measure.total)}%)` : 'Not measured';
}

// Named steps kept as facts on one record (a decision's src/decision-progress.json): each step counts only when its own
// fact is true, and the words name the furthest step reached, so "2 of 3" also says which two.
export function progressFromSteps(record, rows) {
  const steps = Array.isArray(rows?.steps) ? rows.steps : [];
  if (!record || typeof record !== 'object' || !steps.length) return 'Not measured';
  const met = steps.filter(step => record[step.field] === true);
  const words = progressWords({ done: met.length, total: steps.length, unit: rows.unit, unit_one: rows.unit_one });
  return met.length ? `${words} · ${met.at(-1).says}` : words;
}

// The words for one job from the parts handed on from it directly: a part counts once it finished with a result (a part
// with parts of its own counts when it is finished itself). A job with no parts has no denominator and is Not measured,
// never a guess from its status word. The board, a job's read and its page all count this way, from the parts each
// already read, so they agree.
export const progressOfParts = parts => (Array.isArray(parts) && parts.length && parts.length <= 200
  ? progressWords({ done: parts.filter(part => part?.state === 'finished' && part.result !== undefined && part.result !== null).length, total: parts.length, unit: 'parts', unit_one: 'part' })
  : 'Not measured');

// A work reference may name a whole tree. Count only its actual leaf jobs; a
// single open-ended job has no known denominator and therefore no percentage.
export function progressFromWorkParts(parts, rootId) {
  if (!Array.isArray(parts) || !parts.some(part => part.handoff_id === rootId) || parts.length >= 50) return null;
  const children = parts.filter(part => part.parent_handoff_id);
  if (!children.length) return null;
  const parents = new Set(children.map(part => part.parent_handoff_id));
  const leaves = children.filter(part => !parents.has(part.handoff_id));
  if (!leaves.length) return null;
  return { done: leaves.filter(part => part.state === 'finished' && part.result).length, total: leaves.length, unit: 'jobs', unit_one: 'job' };
}

// A saved milestone tree is a bounded scope only when every node has a label and
// a known state. Completed leaves count only when the leaf carries verification
// evidence; a status word alone never advances measured progress.
export function progressFromMilestoneTree(tree) {
  if (typeof tree === 'string') {
    try { tree = JSON.parse(tree); } catch { return null; }
  }
  const jobs = tree?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return null;
  let total = 0;
  let done = 0;
  const visit = (job, depth = 0) => {
    if (depth > 20 || !job || typeof job !== 'object' || Array.isArray(job)
      || typeof job.title !== 'string' || !job.title.trim()
      || typeof job.state !== 'string' || !job.state.trim()) return false;
    if (job.children !== undefined && !Array.isArray(job.children)) return false;
    const children = job.children ?? [];
    if (children.length) {
      for (const child of children) if (!visit(child, depth + 1)) return false;
      return true;
    }
    total += 1;
    if (!job.blocked_by && /^(done|finished|complete|completed)$/i.test(job.state.trim())
      && typeof job.verified_by === 'string' && job.verified_by.trim()) done += 1;
    return true;
  };
  if (!jobs.every(job => visit(job)) || total === 0 || total > 200) return null;
  return { done, total, unit: 'jobs', unit_one: 'job' };
}

export function progressForListRow(measure, values, progressOfReference = () => null) {
  if (!measure || typeof measure !== 'object' || !values || typeof values !== 'object') return 'Not measured';
  let amount;
  if (typeof measure.source_field === 'string') {
    const ref = values[measure.source_field];
    amount = typeof ref === 'string' && ref ? progressOfReference(ref) : null;
    if (!amount && typeof measure.tree_field === 'string') amount = progressFromMilestoneTree(values[measure.tree_field]);
  } else if (typeof measure.tree_field === 'string') {
    amount = progressFromMilestoneTree(values[measure.tree_field]);
  } else {
    const done = values[measure.done_field];
    const total = values[measure.total_field];
    const evidence = values[measure.evidence_field];
    if (!measure.done_field || !measure.total_field || !measure.evidence_field || !evidence) return 'Not measured';
    // Open-ended work (rounds with no plan, src/work-rounds.mjs) has no denominator: it says how many units its evidence
    // records, never a percentage.
    if (measure.open_ended === true && (total === undefined || total === null || total === '') && Number.isSafeInteger(Number(done)) && Number(done) > 0) {
      const many = typeof measure.unit === 'string' && measure.unit.trim() ? measure.unit.trim() : 'steps';
      return `${Number(done)} ${Number(done) === 1 && measure.unit_one ? measure.unit_one : many} finished, no end set`;
    }
    amount = { done: Number.isSafeInteger(Number(done)) ? Number(done) : done, total: Number.isSafeInteger(Number(total)) ? Number(total) : total, unit: measure.unit, unit_one: measure.unit_one };
  }
  const count = countWords(amount);
  if (!count) return 'Not measured';
  const state = values[measure.state_field];
  if (typeof measure.state_field === 'string' && Array.isArray(measure.finished_values) && typeof state === 'string'
    && measure.finished_values.includes(state) !== (amount.done === amount.total)) {
    return `Needs review: marked ${state}; ${count}`;
  }
  return progressWords(amount);
}
