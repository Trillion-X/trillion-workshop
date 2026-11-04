// Prose titles can contain punctuation; a single token can still be an action id.
const looksLikeId = text => !/\s/.test(text) && (/[_:/]/.test(text) || /^[a-z0-9]+(-[a-z0-9]+)+$/.test(text));
const wordsOf = token => capital(token.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase());

/** What a tool is called for a person: its own title, name or label when that reads as words; otherwise the action its
 *  id names (`agentmail-list_messages` is "List messages", from the service "Agentmail"). */
export function titleOf(tool) {
  const named = [tool.title, tool.name, tool.label].find(text => typeof text === 'string' && text.trim() && !looksLikeId(text.trim()));
  // A name is kept as written except a leading lowercase word, so iMessage stays iMessage and "count letters" reads as a title.
  if (named) return { title: /^[a-z](?![A-Z])/.test(named.trim()) ? capital(named.trim()) : named.trim(), service: null };
  const bare = String(tool.tool_id ?? tool.label ?? '').replace(/^[a-z-]+:/, '');
  // The service is the hyphen-joined words before the action; the action is the first word that joins with `_`.
  const split = bare.match(/^(.*?)-([^-]*_.*)$/);
  return split ? { title: wordsOf(split[2]), service: wordsOf(split[1]) } : { title: wordsOf(bare), service: null };
}
