// tools/workflows/do-work/run-with-sql.mjs
//
// The command a workflows row runs when its tool keeps rows in the person's own Postgres and reads nothing from the person's
// files: it imports the module the row names, calls the export the row names with the run's stdin and prints { result } (or
// { error }) as its last line. How the run works, and what the function is handed, is read-data/with-sql.mjs.
//
//   node /opt/workflows/do-work/run-with-sql.mjs /opt/<tool>/read-data/<file>.mjs <export> [--sql /opt/<tool>/sql]...  < { input, task }
//
// Each `--sql FOLDER` is a folder of `.sql` files (one `create ... if not exists` statement each) the tool makes its own tables
// from, applied after this folder's own `sql/` in one transaction.
import { runWithSql } from '../read-data/with-sql.mjs';

const [file, name, ...extra] = process.argv.slice(2);
const sqlFolders = [];
let usageOk = true;
for (let at = 0; at < extra.length; at += 2) {
  if (extra[at] === '--sql' && extra[at + 1]) sqlFolders.push(extra[at + 1]);
  else usageOk = false;
}
await runWithSql({ file, name, usageOk, sqlFolders });
