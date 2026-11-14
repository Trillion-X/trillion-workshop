// Pure leaf (zero I/O): extract a REAL, author-supplied version_lineage from a package contract.
//
// Only facets the contract actually authors are returned; anything missing is simply absent — never a
// null-filler, never a fabricated default (L117). Returns null when the contract authors no version data
// at all, so the caller omits the `version_lineage` key entirely. Real version values are stamped onto a
// package's own `things-to-store-and-run.json` at publish time; this leaf only reflects what is authored.
export function authoredVersionLineage(contract) {
  const authored = contract && typeof contract === 'object' ? contract.version_lineage : null;
  if (!authored || typeof authored !== 'object') {
    return null;
  }
  const facets = {};
  if (typeof authored.version === 'string' && authored.version.trim()) {
    facets.version = authored.version.trim();
  }
  if (typeof authored.supersedes === 'string' && authored.supersedes.trim()) {
    facets.supersedes = authored.supersedes.trim();
  }
  if (typeof authored.channel === 'string' && authored.channel.trim()) {
    facets.channel = authored.channel.trim();
  }
  if (authored.compat && typeof authored.compat === 'object') {
    facets.compat = authored.compat;
  }
  if (typeof authored.updated_at === 'string' && authored.updated_at.trim()) {
    facets.updated_at = authored.updated_at.trim();
  }
  return Object.keys(facets).length > 0 ? facets : null;
}
