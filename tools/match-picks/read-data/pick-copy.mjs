// tools/match-picks/read-data/pick-copy.mjs
//
// The wording a free pick must not use is the person's own list, given with each request: no term is shipped here. A term
// is found anywhere in a text, in any letter case; a term written with spaces matches any run of white space.
export function findBannedCopy(texts, bannedTerms) {
  if (!Array.isArray(texts) || texts.some(item => typeof item?.text !== 'string')) throw new Error('texts must be a list of { field, text }.');
  if (!Array.isArray(bannedTerms) || bannedTerms.some(term => typeof term !== 'string' || !term.trim())) throw new Error('banned_terms must be a list of words or phrases the person does not want used.');
  const escaped = term => term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const findings = [];
  for (const { field, text } of texts) {
    for (const term of bannedTerms) {
      if (new RegExp(escaped(term), 'i').test(text)) findings.push({ field, term, message: `${field ?? 'text'} cannot contain ${JSON.stringify(term)}.` });
    }
  }
  return { passed: findings.length === 0, findings };
}
