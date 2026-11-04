// tools/list-tools-for-an-ai/read-data/listing-tools.mjs
//
// The four rows' functions. Each hands its input to a module moved from trillion (tool-listing-budget.mjs,
// tool-behavior-notes.mjs, tool-write-class.mjs, tool-releases.mjs) and answers what it says. No records are read.
import { listWithinBudget, listingMeta, withNamedInFull } from './tool-listing-budget.mjs';
import budgetRules from './tool-listing-budget.json' with { type: 'json' };
import { withBehaviorNotes } from './tool-behavior-notes.mjs';
import { writeClassOf } from './tool-write-class.mjs';
import { compatibleRelease, oldestNeeded } from './tool-releases.mjs';

/** tool:fit-a-tool-list-in-a-budget: the most detailed list that fits budget_chars, with the named tools in full. */
export function fitToolList({ tools = [], budget_chars, names } = {}) {
  const within = listWithinBudget(tools, budget_chars);
  const named = withNamedInFull(within ? within.tools : tools, tools, names);
  const listing = within ? listingMeta(within, budget_chars)[budgetRules.meta_key] : {};
  if (named.unknown.length) Object.assign(listing, { unknown: named.unknown, unknown_said: named.said.replace('{names}', named.unknown.join(', ')) });
  return { tools: named.tools, listing };
}

/** tool:say-a-tools-hints-in-its-description: the tool with the sentences its hints call for. */
export const notedTool = ({ tool } = {}) => withBehaviorNotes(tool);

/** tool:tell-if-a-tool-changes-anything: 'read' or 'write' for one tool descriptor. */
export const writeClassRow = ({ tool } = {}) => ({ write_class: writeClassOf(tool) });

/** tool:pick-the-release-a-host-runs: the release of a published row host_version runs, or null and the version needed. */
export function releaseForHost({ row, host_version } = {}) {
  if (typeof host_version !== 'string' || !host_version) throw new Error('Give host_version, the version of the Trillion that will run the tool.');
  const release = compatibleRelease(row, host_version);
  return { release, ...(release ? {} : { oldest_needed: oldestNeeded(row) }) };
}
