// tools/calendar/do-work/read-time-blocks.mjs
// The command of tool:read-time-blocks. Input (stdin, JSON):
//   { lenses, feeds, account_lenses?, queued_changes?, conflicts? }
// Prints { blocks, diagnostics, issues, accounts?, queued_blocks?, conflict_blocks? }.
import { isRecord, refuse, runCommand } from './command.mjs';
import { readAccounts, readSyncStates, readTimeBlocks } from '../read-data/time-blocks.mjs';

const lists = ['lenses', 'account_lenses', 'queued_changes', 'conflicts'];

export function readTimeBlocksFor(input) {
  if (!isRecord(input)) throw new Error('Give { lenses, feeds }.');
  const problems = [];
  if (!Array.isArray(input.lenses)) problems.push('lenses must be a list of time-block-lens records');
  if (!isRecord(input.feeds)) problems.push('feeds must be an object of row lists by input_address');
  else for (const [address, rows] of Object.entries(input.feeds)) if (!Array.isArray(rows)) problems.push(`feeds.${address} must be a list of rows`);
  for (const name of lists.slice(1)) if (input[name] !== undefined && !Array.isArray(input[name])) problems.push(`${name} must be a list`);
  refuse(problems);
  const answer = readTimeBlocks(input.lenses, input.feeds);
  if (input.account_lenses) {
    const read = readAccounts(input.account_lenses, input.feeds);
    answer.accounts = read.accounts;
    answer.issues.push(...read.issues);
  }
  if (input.queued_changes || input.conflicts) {
    const read = readSyncStates(input.queued_changes ?? [], input.conflicts ?? []);
    answer.queued_blocks = read.queuedBlocks;
    answer.conflict_blocks = read.conflictBlocks;
  }
  return answer;
}

runCommand(import.meta.url, readTimeBlocksFor);
