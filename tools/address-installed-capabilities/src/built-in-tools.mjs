// src/built-in-tools.mjs
//
// Purpose: the Workshop tools that run inside this Worker (placement:this-worker, executor "worker-module"). A tool
// row says which module and which export run it (`invoke: { kind: "worker-module", module, export }`); the host hands
// in the modules by name. The same executor serves a person's Workshop (an AI's run_tool, with its tasks, checks and
// plan) and Trillion's own callers in the same process (`run`), so each engine has one implementation reached one way.
//
// Non-Negotiable Invariants:
//   1. Nothing here names a module, an export or a tool: rows are DATA and modules are owner wiring.
//   2. `run(tool_id, input, host)` finds the row among the rows given, picks the first of its placements whose executor
//      is held here, and returns what the export returns, as it returns it (a plain value stays plain, so a synchronous
//      export can serve a synchronous caller). No task is kept, no plan is checked and nothing crosses the network.
//   3. `host` is the in-process caller's own callbacks for the export (reading its records, running a send); an AI's
//      run_tool never has one, so every export works without it.
//   4. A row, placement, module or export that is missing is refused with its name.
//
import { readToolData } from '../../ai-tool-catalog/read-data/read-ai-tool-catalog.ts';

/** The executor for placement kind "worker-module": modules is { [module name]: { [export]: (input, host?) → result } }. */
export const workerModuleExecutor = modules => ({ invocation, input, host = null }) => {
  const module = modules[invocation?.module];
  if (!module) throw new Error(`No module named ${invocation?.module} runs in this Worker.`);
  const run = module[invocation.export];
  if (typeof run !== 'function') throw new Error(`The module ${invocation.module} has no ${invocation.export}.`);
  return run(input, host);
};

/**
 * payloads:  the shared rows that name these tools and their placements (tool descriptors, tool placements)
 * executors: { [executor id]: executor } this host runs in process, e.g. { "worker-module": workerModuleExecutor(modules) }
 */
export function makeBuiltInTools({ payloads, executors }) {
  // The rows are read on the first run, never when the host is made: every person's store makes this as its code loads,
  // and reading every row then (each one's secret paths checked) cost each cold store's first answer about 40 ms.
  let read = null;
  const rows = () => {
    if (read) return read;
    const { tools, placements } = readToolData(payloads.map(payload => ({ payload })));
    read = { toolsById: new Map(tools.map(tool => [tool.id, tool])), placementsById: new Map(placements.map(place => [place.id, place])) };
    return read;
  };
  const chosen = new Map();
  function choose(tool_id) {
    if (chosen.has(tool_id)) return chosen.get(tool_id);
    const { toolsById, placementsById } = rows();
    const tool = toolsById.get(tool_id);
    if (!tool) throw new Error(`There is no built-in tool ${tool_id}.`);
    const place = (tool.placements ?? []).map(id => placementsById.get(id)).find(item => item && executors[item.executor]);
    if (!place) throw new Error(`${tool_id} names no placement this host runs in process.`);
    const pick = { tool, place };
    chosen.set(tool_id, pick);
    return pick;
  }
  return {
    run(tool_id, input, host = null) {
      const { tool, place } = choose(tool_id);
      return executors[place.executor]({ tool, placement: place, invocation: tool.invoke, input, host });
    },
    executors,
  };
}
