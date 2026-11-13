/** Run a caller-ordered set of calendar removals without hiding partial outcomes. */
export async function runCalendarBatchRemoval(rows, remove) {
  const removed = [];
  const failed = [];
  for (const row of rows) {
    try {
      await remove(row);
      removed.push(row);
    } catch (error) {
      failed.push({ row, error });
    }
  }
  return { removed, failed };
}
