  const { optionUnits } = await import('./unit-context.mjs');
  const ruled = new Set(readVerdicts(path).filter(row => real.includes(row.by) && ['bad', 'good'].includes(row.verdict) && row.film).map(row => row.text));
  const left_out = { excluded: 0, ruled_directly: 0, both_labels: 0, no_spec: [], several_specs: [] };
  const byText = new Map();
  for (const config of globSync('*/pick-gate.json', { cwd: films }).sort()) {
    const folder = join(films, dirname(config));
    const gate = JSON.parse(readFileSync(join(films, config), 'utf8'));
    const labels = gate.pick_labels;
    if (!labels) continue;
    const ledger = join(folder, gate.verdict_file);
    const latest = new Map(decisionsOf(folder).map(row => [row.option_id, row]));
    for (const [option, row] of latest) {
      // Lines his words single out: the row's own `lines` (pick_gate.py record-pick --line), else rejected_lines for older rows.
      const picked = gate.picked_verdicts.includes(row.verdict);
      const named = row.lines ? { lines: row.lines } : labels.rejected_lines?.[option];
      const label = picked ? 'good' : named && /^rejected/.test(row.verdict) ? 'bad' : null;
      if (!label) continue;
      const specs = labels.spec_globs.flatMap(pattern => globSync(pattern.replaceAll('{option}', option), { cwd: folder }));
      if (specs.length !== 1) { left_out[specs.length ? 'several_specs' : 'no_spec'].push(option); continue; }
      const spec = join(folder, specs[0]);
      const words = Object.entries(labels.words ?? {}).find(([prefix]) => specs[0].startsWith(`${prefix}/`))?.[1];
      const excluded = new Set([...(labels.exclude?.[option] ?? []).map(entry => entry.text), ...(picked ? row.lines ?? [] : [])]);
      for (const unit of optionUnits(spec, { words: words ? join(folder, words) : null, textKeys: labels.text_keys, leadS: labels.spoken_lead_s })) {
        if (label === 'bad' && !named.lines.includes(unit.text)) continue;
        if (excluded.has(unit.text)) { left_out.excluded += 1; continue; }
        if (ruled.has(unit.text)) { left_out.ruled_directly += 1; continue; }
        const item = { text: unit.text, good: label === 'good', bad_for: label === 'bad' ? ['real-bad-film'] : [], split: 'real', source: 'pick-implied',
          kind: unit.kind, option, verdict: row.verdict, his_words: row.reason_verbatim, ledger, spec, context: unit.context };
        const seen = byText.get(unit.text);
        if (!seen) byText.set(unit.text, item);
        else if (seen.good !== item.good) seen.conflict = true;
      }
    }
  }
  const items = [...byText.values()].filter(item => !item.conflict);
  left_out.both_labels = byText.size - items.length;
  return { items, left_out };
}
