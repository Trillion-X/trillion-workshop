// src/tool-allowlist.mjs
//
// Purpose: a caller narrows its own tool list. A coding agent started for one job is given a key and asks for only the
// tools that job needs; the Worker lists and runs only those, so the agent can reach nothing else through this sign-in.
//
// Non-negotiable invariants
//   1. Narrowing only: the tools offered are the sign-in's own (its reach decides those) intersected with the names asked
//      for. A name that is not one of the sign-in's tools adds nothing.
//   2. No header, or a header with no names, narrows nothing.
//   3. The header is bounded (src/tool-allowlist.json); a longer one is cut, never refused, so a long list cannot lock a caller out.
import settings from '../../shared-code/src/tool-allowlist.json' with { type: 'json' };

/** The names a request asks for, or null when it asks for no narrowing. */
export function askedTools(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue.trim()) return null;
  const names = headerValue.slice(0, settings.most_header_chars).split(',').map(name => name.trim()).filter(Boolean).slice(0, settings.most_names);
  return names.length ? new Set(names) : null;
}

/** The tools of `tools` this request narrowed itself to (all of them when it asked for no narrowing). */
export const narrowedTo = (tools, headerValue) => {
  const asked = askedTools(headerValue);
  return asked ? tools.filter(tool => asked.has(tool.name)) : tools;
};

export const narrowingHeader = settings.header;
