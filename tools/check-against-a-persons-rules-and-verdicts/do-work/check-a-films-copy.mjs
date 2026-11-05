if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const valueFlags = new Set(['--kind', '--rules', '--decider', '--json', '--report', '--reader', '--owner', '--context', '--stage', '--verdict-rules', '--artifact-kind', '--plan']);
  const boolFlags = new Set(['--no-model', '--quiet']);
  const files = [];
  for (let at = 0; at < args.length; at++) {
    if (boolFlags.has(args[at])) continue;
    if (valueFlags.has(args[at])) { at++; continue; }
    if (args[at].startsWith('--')) { console.error(`unknown option: ${args[at]}`); process.exit(2); }
    files.push(args[at]);
  }
  if (!files.length) { console.error('usage: node check.mjs <file>... [--reader film|sectioned-prose|cue-narration|json-words] [--owner DATA-ID] [--kind K] [--rules copy-rules.json] [--decider live|cache] [--no-model] [--stage final|review] [--verdict-rules verdict-rules.json] [--artifact-kind K] [--plan plan.json] [--context context.json] [--json out] [--report out]'); process.exit(2); }
  const reader = value('--reader') ?? 'film';
  const owner = value('--owner');
  const noModel = args.includes('--no-model');
  if (value('--stage') && !['final', 'review'].includes(value('--stage'))) { console.error('--stage must be final or review.'); process.exit(2); }
  let argumentError = null;
  if (value('--json') && value('--report')) { console.error('Choose one of --json or --report.'); process.exit(2); }
  if (noModel && value('--decider')) { console.error('--no-model cannot be combined with --decider.'); process.exit(2); }
  if (reader === 'json-words' && !owner) argumentError = 'The json-words reader requires --owner DATA-ID.';
  if (reader !== 'json-words' && owner) argumentError = '--owner is only valid with --reader json-words.';
  if (reader === 'json-words' && value('--kind')) argumentError = 'JSON owner kind is selected by DATA; --kind is not allowed.';
  let selectedReader, ruleSet, coverage, verdictRules = null;
  try {
    if (argumentError) throw new Error(argumentError);
    if (value('--verdict-rules')) verdictRules = loadVerdictRules(value('--verdict-rules'));
    selectedReader = readerProfile(reader, owner);
    ruleSet = currentRules({ path: value('--rules') });
    if (!Array.isArray(ruleSet.rules) || ruleSet.rules.length === 0) throw new Error('No applicable copy rules were supplied.');
    coverage = files.map(file => readFileWithCoverage(file, { kind: value('--kind'), reader, owner, artifactKind: value('--artifact-kind'), plan: value('--plan') }));
  } catch (error) {
    console.error(`UNQUALIFIED: ${error.message}`);
    if (value('--report')) writeFileSync(value('--report'), JSON.stringify({ schema: 'copy-check-report-v1', status: 'unqualified',
      reader: { id: reader, source_blake3: selectedReader?.blake3 ?? null },
      ...(owner ? { owner: { id: owner, blake3: selectedReader?.ownerBlake3 ?? null } } : {}),
      checker_blake3: b3(readFileSync(fileURLToPath(import.meta.url))),
      rules: { blake3: ruleSet?.rules ? b3(Buffer.from(JSON.stringify(ruleSet.rules))) : null, count: ruleSet?.rules?.length ?? null, source: ruleSet?.said ?? null },
      mode: noModel ? 'no-model diagnostic; asking rules retained as unknown' : value('--decider') ?? 'live', files: [], results: [] }, null, 2));
    process.exit(2);
  }
  const fileCoverage = coverage.map((entry, index) => ({
    ...entry.coverage,
    issues: entry.coverage.issues ?? [],
    recognized_units: entry.units.length,
    status: !entry.units.length || (entry.coverage.issues ?? []).length ? 'unqualified' : 'extracted',
  }));
  const unqualified = fileCoverage.some(file => file.status === 'unqualified');
  const units = dedupe(coverage.flatMap(entry => entry.units));
  // Film context (unit-context.mjs build DATA), matched by exact text; a unit with no rebuilt context is judged alone.
  const placed = new Map(value('--context') ? JSON.parse(readFileSync(value('--context'), 'utf8')).units.filter(unit => unit.context).map(unit => [unit.text, unit.context]) : []);
  for (const unit of units) if (placed.has(unit.text)) unit.context = placed.get(unit.text);
  if (unqualified) {
    const summary = fileCoverage.map(file => `${file.path}: ${file.recognized_units} recognized unit(s), ${file.issues.length} issue(s)`);
    console.error(`UNQUALIFIED: every input file must produce recognized copy with no reader issues.\n${summary.join('\n')}`);
    if (value('--report')) writeFileSync(value('--report'), JSON.stringify({ schema: 'copy-check-report-v1', status: 'unqualified',
      reader: { id: reader, source_blake3: selectedReader.blake3 },
      ...(owner ? { owner: { id: owner, blake3: selectedReader.ownerBlake3 } } : {}),
      checker_blake3: b3(readFileSync(fileURLToPath(import.meta.url))),
      rules: { blake3: b3(Buffer.from(JSON.stringify(ruleSet.rules))), count: ruleSet.rules.length, source: ruleSet.said },
      mode: noModel ? 'no-model diagnostic; asking rules retained as unknown' : value('--decider') ?? 'live',
      coverage: { files: fileCoverage, extracted_units: coverage.reduce((sum, entry) => sum + entry.units.length, 0), unique_units: 0, evaluated_units: 0 }, results: [] }, null, 2));
    if (value('--json')) writeFileSync(value('--json'), '[]\n');
    process.exit(2);
  }
  let results;
  try {
    const reading = units.filter(unit => !unit.view), found = reading.length ? readerKnowledgeFindings(reading) : [];
    let next = 0;
    results = check(units, ruleSet.rules, { mode: value('--decider') ?? 'live', noModel, inOrder: units.map(unit => (unit.view ? [] : found[next++])), stage: value('--stage') ?? undefined,
      ...(verdictRules ? { verdictRules, stances: await refreshStances({ rules: value('--verdict-rules') }) } : {}) });
  } catch (error) {
    console.error(`UNQUALIFIED: ${error.message}`);
    process.exit(2);
  }
  const ruleBytes = Buffer.from(JSON.stringify(ruleSet.rules));
  const reportData = {
    schema: 'copy-check-report-v1',
    status: results.some(result => result.qualification === 'unqualified') ? 'unqualified'
      : results.some(result => result.verdict === 'fail') ? 'failed' : results.some(result => result.verdict === 'uncertain') ? 'uncertain' : 'passed',
    reader: { id: reader, source_blake3: selectedReader.blake3 },
    ...(owner ? { owner: { id: owner, blake3: selectedReader.ownerBlake3 } } : {}),
    checker_blake3: b3(readFileSync(fileURLToPath(import.meta.url))),
    rules: { blake3: b3(ruleBytes), count: ruleSet.rules.length, source: ruleSet.said },
    ...(verdictRules ? { verdict_rules: { blake3: b3(Buffer.from(JSON.stringify(verdictRules.doc))), count: verdictRules.doc.rows.length, source: value('--verdict-rules') } } : {}),
    mode: noModel ? 'no-model diagnostic; asking rules retained as unknown' : value('--decider') ?? 'live',
    coverage: { files: fileCoverage, extracted_units: coverage.reduce((sum, entry) => sum + entry.units.length, 0),
      unique_units: units.length, evaluated_units: results.length },
    results,
  };
  console.log(args.includes('--quiet') ? `copy check: ${results.length} units; ${reportData.status}` : report(results, ruleSet.said));
  if (!noModel) {
    const { recordVerdicts, logPath } = await import('./verdicts.mjs');   // verdicts.mjs imports this file for its status
    let logged = 0;
    try { logged = recordVerdicts(results.flatMap(r => r.uncertain.filter(u => u.log_verdict !== false).map(u => ({ text: r.text, kind: r.kind, where: r.where, verdict: 'escalated', by: 'decider-2b', rule: u.rule, p_fail: u.p_fail, adapter: u.adapter ?? null, why: u.why })))); }
    catch (error) { console.log(`\nnot logged: ${error.message}`); }   // a fixture run or a test run never writes the real log; the report still goes out
    if (logged) console.log(`\n${logged} escalated line(s) added to ${logPath()}`);
  }
  if (value('--json')) writeFileSync(value('--json'), JSON.stringify(results, null, 1));
  if (value('--report')) writeFileSync(value('--report'), JSON.stringify(reportData, null, 2));
  process.exit(reportData.status === 'unqualified' ? 2 : reportData.status === 'failed' ? 1 : reportData.status === 'uncertain' ? 3 : 0);
}
