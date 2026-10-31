// The licence of every package in a package-lock.json, judged against licence-classes.json, the one list of licences
// and the run rights each class gives. The lock is one install that every tool whose code is in this repository may
// import, so a package runs wherever any of those tools runs:
//   - its licence (an SPDX expression: AND needs every term, OR any one) names licences some class lists, else it is
//     refused as unknown, never guessed;
//   - that class allows every placement a tool row of this repository's own code names (a row whose invoke names
//     another repository runs that repository's code, not this lock's), and when the class asks for the source to be
//     offered to every user, every such row's class offers it too.
// A dev package runs only in the maker's own tests, never with a tool, so its licence must be known and nothing more.
// Returns the refusals, one line each; none means the lock passes.

const tokensOf = expression => expression.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/);

// An SPDX expression as a tree: { or: [...] }, { and: [...] } or a licence id ("X WITH Y" is one id, listed as written).
function parse(expression) {
  const tokens = tokensOf(expression);
  let at = 0;
  const term = () => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = either();
      if (tokens[at++] !== ')') throw new Error('unbalanced parentheses');
      return inner;
    }
    if (!token || ['AND', 'OR', 'WITH', ')'].includes(token)) throw new Error(`unexpected ${token ?? 'end'}`);
    if (tokens[at] === 'WITH') {
      if (!tokens[at + 1] || ['AND', 'OR', 'WITH', '(', ')'].includes(tokens[at + 1])) throw new Error('WITH names no exception');
      at += 2;
      return `${token} WITH ${tokens[at - 1]}`;
    }
    return token;
  };
  const both = () => { const parts = [term()]; while (tokens[at] === 'AND') { at++; parts.push(term()); } return parts.length === 1 ? parts[0] : { and: parts }; };
  const either = () => { const parts = [both()]; while (tokens[at] === 'OR') { at++; parts.push(both()); } return parts.length === 1 ? parts[0] : { or: parts }; };
  const tree = either();
  if (at !== tokens.length) throw new Error(`unexpected ${tokens[at]}`);
  return tree;
}

/** Refusals for `lock` (a parsed package-lock.json), given licence-class payloads and the repository's tool row payloads. */
export function lockLicenceRefusals(lock, classes, rows) {
  const classOf = licence => classes.find(item => item.licences.includes(licence));
  const own = rows.filter(row => row.kind === 'ai-tool-descriptor' && !row.invoke?.repository);
  const placements = [...new Set(own.flatMap(row => row.placements ?? []))];
  const withholdSource = own.filter(row => !classes.find(item => item.id === row.licence_class)?.serve_source_link);
  // Why one licence id cannot be used here, or null when it can.
  const why = (licence, dev) => {
    const cls = classOf(licence);
    if (!cls) return `${licence} is in no licence class`;
    if (dev) return null;
    const missing = placements.filter(place => !cls.allowed_placements.includes(place));
    if (missing.length) return `${licence} is ${cls.id}, which does not allow ${missing.join(', ')}, where this repository's tools run`;
    if (cls.serve_source_link && withholdSource.length) return `${licence} is ${cls.id}, which asks for the source to be offered, and ${withholdSource[0].id} (${withholdSource[0].licence_class}) does not offer it`;
    return null;
  };
  const judge = (tree, dev) => {
    if (typeof tree === 'string') return why(tree, dev);
    const reasons = (tree.and ?? tree.or).map(part => judge(part, dev));
    return tree.and ? reasons.find(Boolean) ?? null : reasons.every(Boolean) ? reasons.join('; and ') : null;
  };
  const refusals = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || entry.link) continue;
    const licence = entry.license;
    if (typeof licence !== 'string' || !licence.trim()) { refusals.push(`${path} names no licence`); continue; }
    let tree;
    try { tree = parse(licence); } catch (error) { refusals.push(`${path} (${licence}): not an SPDX expression: ${error.message}`); continue; }
    const reason = judge(tree, Boolean(entry.dev));
    if (reason) refusals.push(`${path} (${licence}): ${reason}`);
  }
  return refusals;
}
