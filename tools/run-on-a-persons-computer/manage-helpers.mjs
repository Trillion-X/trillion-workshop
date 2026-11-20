// tools/run-on-a-persons-computer/manage-helpers.mjs
//
// The helper manager's tool function (tool:manage-helpers), moved from the old computer/helper-runtimes.mjs of the previous product repository
// (helperTools.manage, deleted by dc79bb0a87). It is one function over the runtimes that helper-runtimes.mjs
// (makeHelperRuntimes) returns: list, ensure, enable, disable. Any other action is refused in words, and a refusal says
// whether a retry can help (`retry`). Nothing here names a helper; the rows are helper-runtimes.json.
//
// Wiring: the Mac host runs a tool only through its tool map (run-on-a-persons-computer/mac-tools.json); adding the
// map entry for tool:manage-helpers is a Mac-host change and is not made here.

const ACTIONS = ['list', 'ensure', 'enable', 'disable'];

export async function manageHelpers(input = {}, runtimes) {
  const action = input?.action;
  if (!ACTIONS.includes(action)) return { error: `no helper action named ${action}`, retry: false };
  try {
    if (action === 'list') return runtimes.list();
    if (action === 'ensure') return await runtimes.ensure({ id: input.id });
    return runtimes.setEnabled({ id: input.id, enabled: action === 'enable' });
  } catch (error) {
    return { error: String(error?.message ?? error), retry: Boolean(error?.retry) };
  }
}
