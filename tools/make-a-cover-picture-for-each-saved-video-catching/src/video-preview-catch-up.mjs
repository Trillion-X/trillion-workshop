// Saved video covers use the account's existing scheduler and namespace result.
// A file arrival enters this bounded queue; older stored files enter through a
// resumable newest-first scan. A terminal Workshop task write wakes its queued
// identity, and the next queue run saves its result under the original file.
// A file that arrives while the queue is full asks for one more scan from the
// newest (`again`) once the scan under way finishes; it never restarts a scan
// in progress, so a camera that records without end cannot keep the scan at
// its first page (2026-10-05: every arrival reset the cursor to the top).
import { CONTENT_IDENTITY, scoredCoverAttempt } from '../../keep-and-wake-ai-sessions-on-this-computer/src/namespace-preview.mjs';
import { withoutSecrets } from '../../keep-and-wake-ai-sessions-on-this-computer/src/scheduler.mjs';

export const COVER_QUEUE_BATCH = 8;
export const COVER_QUEUE_LIMIT = 16;
export const COVER_SCAN_PAGE = 128;
export const COVER_SCAN_REST_MS = 10_000;
export const COVER_RETRY_LIMIT = 3;
export const COVER_RETRY_MS = 60_000;

const one = (sql, query, ...args) => sql.exec(query, ...args).toArray()[0] ?? null;

export function videoPreviewCatchUp(sql, { page, ensure, canonicalOf = identity => identity, now = () => Date.now() }) {
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_preview_queue (
    identity TEXT PRIMARY KEY, due_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
  sql.exec('CREATE INDEX IF NOT EXISTS namespace_preview_queue_due ON namespace_preview_queue (failed, due_ms)');
  sql.exec(`CREATE TABLE IF NOT EXISTS namespace_preview_backfill (
    id INTEGER PRIMARY KEY CHECK (id = 1), cursor_at TEXT, cursor_identity TEXT,
    due_ms INTEGER, done INTEGER NOT NULL DEFAULT 0, again INTEGER NOT NULL DEFAULT 0)`);
  // Only a table made before this column existed is altered: a new book is made with it, and the ALTER read 205 schema rows
  // in the first step of a new Namespace, which that step's admitted bound did not cover (2026-10-21).
  if (!sql.exec('PRAGMA table_info(namespace_preview_backfill)').toArray().some(column => column.name === 'again')) {
    sql.exec('ALTER TABLE namespace_preview_backfill ADD COLUMN again INTEGER NOT NULL DEFAULT 0');
  }

  const state = () => one(sql, 'SELECT cursor_at, cursor_identity, due_ms, done, again FROM namespace_preview_backfill WHERE id = 1');
  const queued = () => one(sql, 'SELECT COUNT(*) AS count, MIN(due_ms) AS first_due FROM namespace_preview_queue WHERE failed = 0');
  const enqueue = identity => {
    if (!CONTENT_IDENTITY.test(identity ?? '')) return false;
    if (one(sql, 'SELECT 1 AS found FROM namespace_preview_queue WHERE identity = ?', identity)) return false;
    if (queued().count >= COVER_QUEUE_LIMIT) {
      // A bulk arrival cannot grow the active queue. Restart the resumable
      // newest-first scan so this file is discovered after a slot opens.
      sql.exec('INSERT OR IGNORE INTO namespace_preview_backfill (id, due_ms) VALUES (1, ?)', now());
      // A finished scan starts again from the newest; one under way is asked for one more pass when it finishes.
      sql.exec('UPDATE namespace_preview_backfill SET cursor_at = NULL, cursor_identity = NULL, due_ms = ?, done = 0, again = 0 WHERE id = 1 AND done = 1', now());
      sql.exec('UPDATE namespace_preview_backfill SET again = 1 WHERE id = 1 AND done = 0 AND cursor_at IS NOT NULL AND again = 0');
      return false;
    }
    return sql.exec('INSERT OR IGNORE INTO namespace_preview_queue (identity, due_ms) VALUES (?, ?) RETURNING identity', identity, now()).toArray().length > 0;
  };
  const retry = (identity, attempts, dueMs, reason) => {
    const tried = attempts + 1;
    const failed = tried >= COVER_RETRY_LIMIT;
    sql.exec('UPDATE namespace_preview_queue SET attempts = ?, due_ms = ?, failed = ?, last_error = ? WHERE identity = ? AND attempts = ? AND due_ms = ? AND failed = 0',
      tried, failed ? null : now() + COVER_RETRY_MS * 2 ** attempts, failed ? 1 : 0, String(reason).slice(0, 300), identity, attempts, dueMs);
  };

  return {
    // Called on the first account request after this capability reaches an
    // existing store. The account's one scheduler arms only when it is new.
    activate() {
      // Every request asks; one after the first finds the row and writes nothing.
      if (state()) return false;
      return sql.exec('INSERT OR IGNORE INTO namespace_preview_backfill (id, due_ms) VALUES (1, ?) RETURNING id', now()).toArray().length > 0;
    },
    restartAfterImportedFiles() {
      // The source's queue and scan cursor belong to its old execution owner.
      // Re-scan all currently visible recipient files through this same owner.
      if (!state()) return this.activate();
      sql.exec('UPDATE namespace_preview_backfill SET cursor_at=NULL,cursor_identity=NULL,due_ms=?,done=0,again=0 WHERE id=1',now());
      return true;
    },
    enqueue,
    // Called inside the same transaction as the terminal Workshop task write.
    // Each terminal write gets a distinct immediately due token. An older
    // in-flight answer may only park or retry the exact token it selected.
    taskSettled(task) {
      if (task?.tool_id !== 'tool:pick-cover-frame' || !['completed', 'failed'].includes(task.state)) return false;
      const identity = task.input?.video;
      const attempt = scoredCoverAttempt(identity, task.request_key);
      if (attempt === null) return false;
      let woken = false;
      // The active queue has at most COVER_QUEUE_LIMIT rows. Resolve only those
      // identities so a file with many aliases does not fan out at task finish.
      for (const row of sql.exec('SELECT identity FROM namespace_preview_queue WHERE attempts = ? AND failed = 0', attempt).toArray()) {
        if (canonicalOf(row.identity) !== identity) continue;
        if (sql.exec(`UPDATE namespace_preview_queue
          SET due_ms = CASE WHEN due_ms IS NULL OR due_ms > 0 THEN 0 ELSE due_ms - 1 END
          WHERE identity = ? AND attempts = ? AND failed = 0 RETURNING identity`, row.identity, attempt).toArray().length) woken = true;
      }
      return woken;
    },
    nextAt() {
      const pending = queued();
      const backfill = state();
      const scanAt = backfill && !backfill.done && pending.count < COVER_QUEUE_LIMIT ? backfill.due_ms : null;
      const times = [pending.first_due, scanAt].filter(value => Number.isFinite(value));
      return times.length ? Math.min(...times) : null;
    },
    async runDue() {
      const started = now();
      const due = sql.exec('SELECT identity, attempts, due_ms FROM namespace_preview_queue WHERE failed = 0 AND due_ms <= ? ORDER BY due_ms, identity LIMIT ?', started, COVER_QUEUE_BATCH).toArray();
      if (due.length) {
        // One corrupt file or unavailable origin must not hold every other
        // cover behind the scheduler's retry/held rule for this source.
        for (const { identity, attempts, due_ms: dueMs } of due) {
          try {
            const answer = await ensure([identity], attempts);
            if (answer?.previews?.[identity]) {
              sql.exec('DELETE FROM namespace_preview_queue WHERE identity = ?', identity);
            } else if (answer?.queued?.includes(identity)) {
              // Workshop task writes wake this row on settlement. The indexed
              // working-task source already checks an interrupted run; no
              // second preview alarm is needed while that task is active.
              sql.exec('UPDATE namespace_preview_queue SET due_ms = NULL, last_error = NULL WHERE identity = ? AND attempts = ? AND due_ms = ?', identity, attempts, dueMs);
            } else {
              retry(identity, attempts, dueMs, 'No drawable cover was produced.');
            }
          } catch (error) {
            retry(identity, attempts, dueMs, withoutSecrets(error));
          }
        }
      }

      const backfill = state();
      const pending = queued().count;
      if (backfill && !backfill.done && backfill.due_ms <= now() && pending < COVER_QUEUE_LIMIT) {
        const cursor = backfill.cursor_at ? { stored_at: backfill.cursor_at, identity: backfill.cursor_identity } : null;
        const read = page(cursor, COVER_SCAN_PAGE);
        const available = Math.min(COVER_QUEUE_BATCH, COVER_QUEUE_LIMIT - pending);
        let last = null;
        let admitted = 0;
        for (const file of read.files) {
          last = file;
          if (String(file.media_type ?? '').toLowerCase().startsWith('video/')) {
            if (enqueue(file.identity)) admitted += 1;
          }
          if (admitted >= available) break;
        }
        const finishedPage = !read.files.length || last?.identity === read.files.at(-1).identity;
        const done = finishedPage && read.next_after === null;
        if (done && backfill.again) {
          sql.exec('UPDATE namespace_preview_backfill SET cursor_at = NULL, cursor_identity = NULL, due_ms = ?, done = 0, again = 0 WHERE id = 1', now() + COVER_SCAN_REST_MS);
        } else {
          sql.exec('UPDATE namespace_preview_backfill SET cursor_at = ?, cursor_identity = ?, due_ms = ?, done = ? WHERE id = 1',
            last?.stored_at ?? backfill.cursor_at, last?.identity ?? backfill.cursor_identity,
            done ? null : now() + COVER_SCAN_REST_MS, done ? 1 : 0);
        }
      }
      return { queued: queued().count, backfill_done: Boolean(state()?.done) };
    },
  };
}
