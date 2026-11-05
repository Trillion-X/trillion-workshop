  const bad = [...new Map(rows.filter(row => real.includes(row.by) && row.verdict === 'bad' && row.film)
    .map(row => [row.text, { text: row.text, kind: row.kind ?? 'voiceover', where: row.where ?? row.film, also_at: [] }])).values()];
  const results = bad.length ? check(bad, doc.rules, { mode, ...(ask ? { ask } : {}) }) : [];
  // A line is caught only when the decider's own answer reaches the row's t_fail, not when the row is uncertain for
  // another reason (no qualification status yet), which would count every answered line.
  const tFail = new Map(doc.rules.map(rule => [rule.id, rule.ask.calibration?.t_fail]));
  const hit = u => u.p_fail !== null && typeof tFail.get(u.rule) === 'number' && u.p_fail >= tFail.get(u.rule);
  const caught = rule => results.filter(r => r.uncertain.some(u => u.rule === rule && hit(u))).length;
  return {
    real_bad_film: bad.length,
    needed,
    promotion_allowed: bad.length >= needed,
    escalated_by_any: results.filter(r => r.uncertain.some(hit)).length,
    per_rule: Object.fromEntries(doc.rules.map(rule => [rule.id, caught(rule.id)])),
    unanswered: results.filter(r => r.uncertain.some(u => u.p_fail === null)).length,
    counts: Object.fromEntries([...new Set(rows.map(row => `${row.by} ${row.verdict}`))].map(k => [k, rows.filter(row => `${row.by} ${row.verdict}` === k).length])),
  };
}
