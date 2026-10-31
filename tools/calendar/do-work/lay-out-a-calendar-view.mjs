// tools/calendar/do-work/lay-out-a-calendar-view.mjs
// The command of tool:lay-out-a-calendar-view. Input (stdin, JSON):
//   { blocks, views, view_id?, anchor?, range_start?, selected_block_id?, utc_offset_minutes? }
// Prints { view, views, anchor_day, days, clashes, skipped, notice? }.
import { isRecord, refuse, runCommand } from './command.mjs';
import { layOutView } from '../read-data/calendar-views.mjs';

export function layOutAView(input) {
  if (!isRecord(input)) throw new Error('Give { blocks, views }.');
  const problems = [];
  for (const name of ['blocks', 'views']) if (!Array.isArray(input[name])) problems.push(`${name} must be a list`);
  if (Array.isArray(input.blocks)) {
    input.blocks.forEach((block, index) => {
      const ok = isRecord(block) && typeof block.id === 'string' && isRecord(block.interval)
        && typeof block.interval.start === 'string' && typeof block.interval.end === 'string';
      if (!ok) problems.push(`blocks[${index}] must be a time block with an id and an interval`);
    });
  }
  for (const name of ['view_id', 'anchor', 'range_start', 'selected_block_id']) if (input[name] !== undefined && typeof input[name] !== 'string') problems.push(`${name} must be text`);
  if (input.utc_offset_minutes !== undefined && !(Number.isInteger(input.utc_offset_minutes) && Math.abs(input.utc_offset_minutes) <= 840)) problems.push('utc_offset_minutes must be a whole number of minutes within a day');
  refuse(problems.slice(0, 20));
  return layOutView(input);
}

runCommand(import.meta.url, layOutAView);
