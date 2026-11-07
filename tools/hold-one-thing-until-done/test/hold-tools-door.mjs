// The generic records stand-in currently answers records operations only. Device lifecycle tests bind the real
// route to that records door plus an explicitly granted tool-run stand-in; ordinary row tests still run containers.
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';
import { answerNeedsYouHoldRoute } from '../do-work/needs-you-hold-route.mjs';

export async function answerHoldWithTools(row, input, { records = [], tool_runs = {} } = {}) {
  const fake = await startFakeDoor({ rights: row.invoke.records.rights, records });
  const runs = [];
  try {
    const recordsDoor = openRecordsDoor({ descriptor: fake.descriptor });
    const door = { ...recordsDoor, async run(tool, input, { key } = {}) {
      if (!row.invoke.records.runs.includes(tool)) throw new Error('tool_run_not_granted');
      runs.push({ tool, input, key });
      if (tool_runs[tool] instanceof Error) throw tool_runs[tool];
      return tool_runs[tool] ?? { started: true };
    } };
    const result = await answerNeedsYouHoldRoute(input, { door });
    return { status: 0, result, kept: [...fake.kept.values()], runs };
  } finally { await fake.close(); }
}
