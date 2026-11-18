import { cosine } from '../../../find-pictures-by-colour-and-likeness/src/meaning.mjs';
import settings from '../../../keep-and-wake-ai-sessions-on-this-computer/src/pool-settings.json' with {type:'json'};
const JOB_KEY_CHARS=200;
export const toolTelemetryMethods = {
  addToolRun(run) {
    const passed = run.contract_passed ? 1 : 0;
    const embedding = run.job_embedding ? JSON.stringify(run.job_embedding) : null;
    return this.ctx.storage.transactionSync(() => {
      const identity=JSON.stringify([run.tool_id,run.bytes_fingerprint??null,run.placement??null,run.state,Boolean(run.contract_passed),run.seconds??null,run.job_embedding??null,run.day??null,run.tool_version??null]);
      if(run.run_key){
        if(typeof run.run_key!=='string'||run.run_key.length>200)throw new TypeError('An opaque original run key is required.');
        const previous=this.sql.exec('SELECT identity FROM tool_run_receipts WHERE run_key=? LIMIT 1',run.run_key).toArray()[0];
        if(previous){if(previous.identity!==identity)throw new Error('This original run key names different work.');return {kept:true,repeated:true};}
        this.sql.exec('INSERT INTO tool_run_receipts VALUES(?,?)',run.run_key,identity);
      }
      this.sql.exec('INSERT INTO tool_runs (day, tool_id, bytes_fingerprint, placement, state, contract_passed, seconds) VALUES (?, ?, ?, ?, ?, ?, ?)',
        run.day??new Date().toISOString().slice(0, 10), run.tool_id, run.bytes_fingerprint ?? null, run.placement ?? null, run.state, passed, run.seconds ?? null);
      this.sql.exec('INSERT INTO tool_jobs (tool_id, job_key, embedding, runs, contract_passed) VALUES (?, ?, ?, 1, ?) ON CONFLICT (tool_id, job_key) DO UPDATE SET runs = runs + 1, contract_passed = contract_passed + excluded.contract_passed',
        run.tool_id, embedding ? embedding.slice(0, JOB_KEY_CHARS) : '', embedding, passed);
      return {kept:true,repeated:false};
    });
  },
  addToolReport(report) {
    if (!report?.tool_id || !['met', 'failed', 'unknown'].includes(report.result)) throw new Error('A tool report needs a tool and a known result.');
    // Requests from an older deployed worker can still arrive during a rollout. Keep them, explicitly unkeyed,
    // instead of inventing the task or person that their old contract never supplied.
    if (!report.report_key) {
      this.sql.exec('INSERT INTO tool_reports (day, tool_id, result) VALUES (?, ?, ?)', report.day??new Date().toISOString().slice(0, 10), report.tool_id, report.result);
      return { kept: true, attribution: 'unavailable' };
    }
    if (typeof report.report_key !== 'string' || report.report_key.length > 200 || !Number.isInteger(report.revision) || report.revision < 1 || report.answered_by !== 'person'
      || report.attribution_basis !== 'trusted_person_source') throw new Error('A current tool report needs an opaque task key, a positive revision and a trusted person source.');
    const previous = this.sql.exec('SELECT tool_id, revision, result FROM tool_reports WHERE report_key = ? LIMIT 1', report.report_key).toArray()[0];
    if (previous && previous.tool_id !== report.tool_id) throw new Error('This report key already names another tool.');
    if (previous?.revision === report.revision && previous.result !== report.result) throw new Error('This report revision already has a different result.');
    this.sql.exec(`INSERT INTO tool_reports (day, tool_id, result, report_key, revision) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(report_key) DO UPDATE SET day = excluded.day, result = excluded.result, revision = excluded.revision
      WHERE excluded.revision > tool_reports.revision`, report.day??new Date().toISOString().slice(0, 10), report.tool_id, report.result, report.report_key, report.revision);
    return { kept: true, repeated: Boolean(previous && previous.revision >= report.revision) };
  },
  // Counts for the tools asked about only, so a search costs nothing for tools it does not consider.
  toolStats(ids, jobEmbedding = null, { aliases = false } = {}) {
    const list = JSON.stringify(ids);
    const stats = Object.fromEntries(ids.map(id => [id, { runs: 0, contract_passed: 0, reported_met: 0, reported_failed: 0, similar_jobs: { runs: 0, contract_passed: 0 } }]));
    // Runs for jobs close in meaning to this one count separately, so a tool proven on similar jobs ranks first. Only
    // the per-job counts are read (tool_jobs), one row at a time from the cursor: each distinct job's vector is
    // compared once, and the run log is never read, so a tool run thousands of times costs what one job costs.
    if (jobEmbedding) {
      const jobs=aliases?'SELECT a.public_id AS tool_id,j.embedding,j.runs,j.contract_passed FROM tool_learning_aliases a JOIN tool_jobs j ON j.tool_id=a.private_id WHERE j.embedding IS NOT NULL AND a.public_id IN (SELECT value FROM json_each(?))':'SELECT tool_id, embedding, runs, contract_passed FROM tool_jobs WHERE embedding IS NOT NULL AND tool_id IN (SELECT value FROM json_each(?))';
      for (const row of this.sql.exec(jobs,list)) {
        if (cosine(jobEmbedding, JSON.parse(row.embedding)) < settings.search.min_similarity) continue;
        stats[row.tool_id].similar_jobs.runs += row.runs;
        stats[row.tool_id].similar_jobs.contract_passed += row.contract_passed;
      }
    }
    const jobs=aliases
      ?'SELECT a.public_id AS tool_id,SUM(j.runs) AS runs,SUM(j.contract_passed) AS passed FROM tool_learning_aliases a JOIN tool_jobs j ON j.tool_id=a.private_id WHERE a.public_id IN (SELECT value FROM json_each(?)) GROUP BY a.public_id'
      :'SELECT tool_id, SUM(runs) AS runs, SUM(contract_passed) AS passed FROM tool_jobs WHERE tool_id IN (SELECT value FROM json_each(?)) GROUP BY tool_id';
    const reports=aliases
      ?"SELECT a.public_id AS tool_id,SUM(r.report_key IS NOT NULL AND r.result='met') AS met,SUM(r.report_key IS NOT NULL AND r.result='failed') AS failed,SUM(r.report_key IS NULL) AS legacy FROM tool_learning_aliases a JOIN tool_reports r ON r.tool_id=a.private_id WHERE a.public_id IN (SELECT value FROM json_each(?)) GROUP BY a.public_id"
      :"SELECT tool_id, SUM(report_key IS NOT NULL AND result = 'met') AS met, SUM(report_key IS NOT NULL AND result = 'failed') AS failed, SUM(report_key IS NULL) AS legacy FROM tool_reports WHERE tool_id IN (SELECT value FROM json_each(?)) GROUP BY tool_id";
    // reads-ok: GROUP BY tool_id over the ids asked about: one row per tool in `ids`.
    for(const row of this.sql.exec(jobs,list).toArray())Object.assign(stats[row.tool_id],{runs:row.runs,contract_passed:row.passed});
    // reads-ok: GROUP BY tool_id over the ids asked about: one row per tool in `ids`.
    for(const row of this.sql.exec(reports,list).toArray())Object.assign(stats[row.tool_id],{reported_met:row.met,reported_failed:row.failed,...(row.legacy?{legacy_unattributed_reports:row.legacy}:{})});
    return stats;
  }
};
// The one schema of the tool telemetry tables, for the shared pool and every addressed resource that keeps them.
export function setupToolTelemetry(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS tool_run_receipts (run_key TEXT PRIMARY KEY,identity TEXT NOT NULL)');
  sql.exec(`CREATE TABLE IF NOT EXISTS tool_runs (day TEXT NOT NULL, tool_id TEXT NOT NULL, bytes_fingerprint TEXT, placement TEXT, state TEXT NOT NULL, contract_passed INTEGER NOT NULL, seconds REAL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS tool_reports (day TEXT NOT NULL, tool_id TEXT NOT NULL, result TEXT NOT NULL)`);
  // The local task keeps every attributed report. This existing table is only its anonymous current projection:
  // one opaque key per task, a revision so delayed retries cannot restore an earlier result. Old unkeyed rows
  // remain readable as unattributed history and never masquerade as confirmed person reports.
  for (const [name, type] of [['report_key', 'TEXT'], ['revision', 'INTEGER']]) {
    if (!sql.exec("SELECT 1 FROM pragma_table_info('tool_reports') WHERE name = ?", name).toArray().length) sql.exec(`ALTER TABLE tool_reports ADD COLUMN ${name} ${type}`);
  }
  sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS tool_reports_key ON tool_reports (report_key)');
  sql.exec('CREATE INDEX IF NOT EXISTS tool_reports_tool ON tool_reports (tool_id)');
  // The meaning of the job each run was for, and of each tool's own job, in the decisions' embedding space.
  if (!sql.exec("SELECT 1 FROM pragma_table_info('tool_runs') WHERE name = 'job_embedding'").toArray().length) sql.exec('ALTER TABLE tool_runs ADD COLUMN job_embedding TEXT');
  // Each tool's runs counted per distinct job, with that job's vector kept once: what a search reads, so its cost
  // follows the distinct jobs of the tools it considers, never how many times they ran. A job is known by the start
  // of its vector's text (JOB_KEY_CHARS characters, a dozen full-precision numbers); a run with no vector counts under ''.
  sql.exec('CREATE TABLE IF NOT EXISTS tool_jobs (tool_id TEXT NOT NULL, job_key TEXT NOT NULL, embedding TEXT, runs INTEGER NOT NULL, contract_passed INTEGER NOT NULL, PRIMARY KEY (tool_id, job_key))');
}
export function toolTelemetry(sql,transaction) {
  setupToolTelemetry(sql);
  const owner={sql,ctx:{storage:{transactionSync:transaction}}};
  return Object.fromEntries(Object.entries(toolTelemetryMethods).map(([name,method])=>[name,method.bind(owner)]));
}
