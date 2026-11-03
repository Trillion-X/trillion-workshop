// src/connection-links.mjs
//
// PURPOSE
//   Which connections the links in some words point at. A link to a service the person has not connected is a reason to
//   offer connecting it right there (src/connection-recommendations.mjs): the web address names the service by the
//   `domain` its connection descriptor declares (parts/service-connections/records.json, carried on each tool row as
//   invoke.connects.domain). It only proposes: connecting stays the person's own step.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here names a service or a domain: both come from the rows handed in.
//   2. A link matches a domain when its host is that domain or a name under it; the longest matching domain wins, so a
//      link to calendar.google.com names the calendar service, not every Google one. Services that share the longest
//      domain are all returned.
//   3. Pure: no reads, no clock. Words with no link match nothing.

const LINK = /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?(?:[/?#][^\s<>"')]*)?/gi;

/** The hosts that appear in some words (links with or without https://), lower case, without a leading www. */
export const hostsIn = text => [...String(text ?? '').matchAll(LINK)].map(match => match[1].toLowerCase().replace(/^www\./, ''));

/** The providers whose declared domain a host in the words falls under, with the host that matched: Map provider -> host. */
export function providersForLinks(text, tools) {
  const domains = tools.map(tool => ({ provider: tool.invoke?.provider, domain: String(tool.invoke?.connects?.domain ?? '').toLowerCase() }))
    .filter(row => row.provider && row.domain);
  const found = new Map();
  for (const host of hostsIn(text)) {
    const under = domains.filter(row => host === row.domain || host.endsWith(`.${row.domain}`));
    const longest = Math.max(0, ...under.map(row => row.domain.length));
    for (const row of under) if (row.domain.length === longest && !found.has(row.provider)) found.set(row.provider, host);
  }
  return found;
}
