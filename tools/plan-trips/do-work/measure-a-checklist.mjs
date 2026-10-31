// tools/plan-trips/do-work/measure-a-checklist.mjs
//
// The command of tool:measure-a-checklist. One JSON request on standard input:
//   { items: [{ id, status, group }], done_statuses: [..], skipped_statuses: [..], ungrouped_label? }
// and { result: { done, total, ratio, groups } } out. See read-data/checklist.mjs.
import { runAsMain } from '../read-data/run-as-main.mjs';
import { measureAChecklist } from '../read-data/checklist.mjs';

await runAsMain(import.meta.url, measureAChecklist);
