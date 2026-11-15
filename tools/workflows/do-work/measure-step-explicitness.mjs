// Public DATA input only. Counts structural gaps separately from semantic claims: no score proves explicitness.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stepAnatomyProblems, stepAnatomyContext, STEP_ANATOMY } from '../read-data/recipe-problems.mjs';

export function measureStepExplicitness(input) {
  const rows = Array.isArray(input) ? input : input?.rows ?? input?.records ?? input?.steps;
  if (!Array.isArray(rows)) throw new TypeError('Input must be a step array or an object with rows, records, or steps.');
  const decoded = rows.map((row, index) => {
    const source = row?.payload ?? row?.values ?? row?.value ?? row;
    const step = source && typeof source === 'object' && !Array.isArray(source) ? { ...source } : source;
    if (step && typeof step === 'object' && step.id === undefined) step.id = step.step ?? row?.id;
    const decoding = [];
    // Published list cells store structured fields as JSON text. Read their actual content, not the wrapper.
    for (const field of ['submit', 'checks', 'run_tool', 'came_from', 'part_of']) if (typeof step?.[field] === 'string') {
      try { step[field] = JSON.parse(step[field]); } catch { decoding.push(`step.${field} contains invalid JSON.`); }
    }
    return { row, index, step, decoding };
  });
  const details = decoded.map(({ row, index, step, decoding }) => {
    // A quoted rejection may contain these words too. Candidates are review hints, never a semantic verdict.
    const phrase_candidates = STEP_ANATOMY.required_text.flatMap(field => typeof step?.[field] === 'string' ? STEP_ANATOMY.open_choice_phrases.filter(phrase => step[field].toLowerCase().includes(phrase)).map(phrase => ({ field, phrase })) : []);
    return { id: row?.id ?? step?.id ?? step?.step ?? null, index, phrase_candidates, problems: [...decoding, ...stepAnatomyProblems(step, { ...stepAnatomyContext(step, decoded.map(item => item.step)), judged: step?.judged === true || step?.run_tool === undefined })] };
  });
  const incomplete = details.filter(row => row.problems.length > 0);
  return {
    total: rows.length, incomplete: incomplete.length, anatomy_complete: rows.length - incomplete.length,
    vague_share: rows.length ? incomplete.length / rows.length : null,
    metric: 'vague_share counts incomplete anatomy only; phrase candidates require review',
    phrase_candidate_steps: details.filter(row => row.phrase_candidates.length > 0).length,
    semantic_explicitness: 'not-measured', limits: STEP_ANATOMY.limits, details: details.filter(row => row.problems.length || row.phrase_candidates.length),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const paths = args.filter(arg => arg !== '--summary');
    if (paths.length > 1 || paths.some(arg => arg.startsWith('--'))) throw new TypeError('Usage: measure-step-explicitness.mjs [public-steps.json] [--summary]; otherwise reads JSON on stdin.');
    const input = JSON.parse(readFileSync(paths[0] ?? 0, 'utf8'));
    const report = measureStepExplicitness(input);
    if (args.includes('--summary')) delete report.details;
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`measure-step-explicitness: ${error.message}\n`);
    process.exitCode = 1;
  }
}
