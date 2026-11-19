# tools/see-what-is-being-worked-on/task-page/

A pursuit's task page: Now (where the work stands) and History (how it got there), drawn from the pursuit's own task tables
on each request. Nothing is copied, stored or timed on the server: the page asks its data URL again while its tab is
visible, and the server answers with one read of the database.

## Files

| File | Purpose |
|------|---------|
| `read-data/read-task-page.mjs` | `readTaskPage(runSql, tables?)`: one read-only SELECT of the task, status and change tables through the caller's SQL runner (`(sql) => { rows }`), mapped to `{ tasks, statuses, changes }`. `taskPageSql(tables?)` is that SELECT; `DEFAULT_TASK_TABLES` names the default tables (`calendar_tasks`, `task_changes`, `task_statuses`). |
| `read-data/task-rows.ts` | The pure fold both views read: moments (changes grouped by minute), each task as it stood at a moment, the tree in its fixed order, how a goal and its work items count, a status's word. A status's meaning comes only from its row. |
| `show/mount-task-page.tsx` | `mount(element, { dataUrl, intervalMs?, seenKey? })`: the screen module contract. Asks `dataUrl` every `intervalMs` (default 5000) only while the tab is visible, redraws only when the answer changed, and keeps the last drawn data when an ask fails. Returns the cleanup. |
| `show/task-page.tsx` | `TaskPage({ data, seenKey, seenBefore })`: the Now and History views behind the Workshop's segmented control; the view is kept in the address (`#history`). |
| `show/now-view.tsx` | Now: a summary, the held-up work, what changed since the reader last looked, and the goal tree (closed at first; done work behind "Show done"). |
| `show/history-view.tsx` | History: a timeline rail over the moments of change, and the checklist as it stood at the chosen moment. |
| `show/task-marks.tsx` | The marks both views draw: a work item's step mark, a goal's ring, the chevron, the status word, the detail of an opened row. |
| `test/*.test.mjs` | Run with the Workshop's test command for this folder (`node --test`). |

## Table shape

The page reads these columns. A pursuit whose tables keep them under other names passes `tables` to `readTaskPage`.

| Table | Columns read |
|-------|--------------|
| tasks (`calendar_tasks`) | `id`, `title`, `plain_title`, `plain_detail`, `parent_id` (text or a one-item list), `status`, `waiting_on`, `made_at`, `changed_at` |
| changes (`task_changes`) | `id`, `task_id`, `at`, `kind`, `status`, `title` (read for kind `from transcript`) |
| statuses (`task_statuses`) | `name`, `mark`, `tone`, `counts_as_done`, `closed`, `place` |

## Dependencies

**Depends on:** `trillion-workshop/tools/ui/show/segmented-control/SegmentedControl`, `trillion-workshop/tools/ui/show/step-mark/StepMark`.

**Depended on by:** the pursuit's own page script (it names this folder's mount and its data URL; nothing else in the Workshop imports it yet).
