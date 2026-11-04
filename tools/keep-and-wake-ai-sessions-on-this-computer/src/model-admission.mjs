// SQL backed reservations for paid inference. The caller supplies the surrounding SQLite transaction
// so reservations serialize with the counters whose limits they protect.
import {identityOf} from './typed-operation-contract.mjs';
export function modelAdmissionTables(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS model_call_reservations (
    id TEXT PRIMARY KEY, day TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL,
    amount INTEGER NOT NULL DEFAULT 1, owner TEXT, state TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS model_call_reservation_amounts (
    id TEXT NOT NULL, budget_id TEXT NOT NULL, day TEXT NOT NULL, purpose TEXT NOT NULL,
    owner TEXT, amount REAL NOT NULL, PRIMARY KEY (id, budget_id))`);
  try { sql.exec('ALTER TABLE model_call_reservations ADD COLUMN remote_id TEXT'); } catch { /* already there */ }
  try { sql.exec('ALTER TABLE model_call_reservations ADD COLUMN spending_permit TEXT'); } catch { /* already there */ }
  try { sql.exec('ALTER TABLE model_call_reservations ADD COLUMN settlement_json TEXT'); } catch { /* already there */ }
  try { sql.exec('ALTER TABLE model_call_reservations ADD COLUMN dispatch_identity TEXT'); } catch { /* already there */ }
  try { sql.exec('ALTER TABLE model_call_reservations ADD COLUMN remote_settled INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
  try { sql.exec('ALTER TABLE model_call_reservations ADD COLUMN spending_settled INTEGER NOT NULL DEFAULT 0'); } catch { /* already there */ }
  try { sql.exec('ALTER TABLE model_call_reservations ADD COLUMN reservation_json TEXT'); } catch { /* already there */ }
  sql.exec('CREATE TABLE IF NOT EXISTS model_call_reservation_closures (id TEXT PRIMARY KEY, closed_at INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS model_call_reservations_day ON model_call_reservations (day, purpose, state)');
  sql.exec('CREATE INDEX IF NOT EXISTS model_call_reservation_amounts_day ON model_call_reservation_amounts (day, budget_id, purpose, owner)');
}

const idOf = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

/**
 * Build atomic reserve/release/settle operations over the shared pool SQL authority.
 * Used counters include reservations, so overlap at the last available call cannot over-admit.
 */
export function modelCallAdmission({ sql, transaction, budgets, used, matches = async (tree, facts) => !tree, account = false, estimate = budget => budget.measure === 'calls' ? 1 : budget.most }) {
  modelAdmissionTables(sql);
  const reconcile = ({ day, owner, rows = [], accounted = [] }) => {
    for (const row of rows) sql.exec(`INSERT INTO model_spend_people (day, person, purpose, model, paid_by, calls, refused, remembered, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (day, person, purpose, model) DO UPDATE SET calls = MAX(calls, excluded.calls), refused = MAX(refused, excluded.refused), remembered = MAX(remembered, excluded.remembered), input_tokens = MAX(input_tokens, excluded.input_tokens), output_tokens = MAX(output_tokens, excluded.output_tokens)`, day, owner, row.purpose, row.model, row.paid_by ?? 'trillion', row.calls, row.refused, row.remembered, row.input_tokens, row.output_tokens);
    for (const accountedId of accounted) {
            const previous = sql.exec('SELECT id FROM model_call_reservations WHERE id = ? AND owner = ? AND day = ? LIMIT 1', accountedId, owner, day).toArray()[0];
      if (previous) { sql.exec('DELETE FROM model_call_reservation_amounts WHERE id = ?', accountedId); sql.exec('DELETE FROM model_call_reservations WHERE id = ?', accountedId); }
    }
  };
  return {
    report(request) { return transaction(() => reconcile(request)); },
    async reserve({ id: requestedId = null, day, purpose, model, owner = null, input = null }) {
      const id = requestedId ?? idOf();
      const binding=identityOf([day,purpose,model,owner,input]);
      const repeated=()=>{
        if (sql.exec('SELECT id FROM model_call_reservation_closures WHERE id=? LIMIT 1',id).toArray()[0]) return { closed: true };
        const existing=sql.exec('SELECT id,day,purpose,model,owner,dispatch_identity FROM model_call_reservations WHERE id=? LIMIT 1',id).toArray()[0];
        if(!existing)return null;
        if(existing.day!==day||existing.purpose!==purpose||existing.model!==model||existing.owner!==owner||existing.dispatch_identity!==binding)
          throw new Error('The model reservation identity was reused for different facts.');
        return {id};
      };
      const prior=repeated();if(prior)return prior;
      const covered = [];
      for (const budget of budgets) if (budget.stop !== false && (budget.when == null || await matches(budget.when, { purpose, model }))) covered.push(budget);
      const estimates = [];
      for (const budget of covered) {
        const prepared = used(budget, day, purpose);
        estimates.push({ budget, amount: estimate(budget, input), readUsed: prepared?.then ? await prepared : () => used(budget, day, purpose) });
      }
      const result = transaction(() => {
        const prior=repeated();if(prior)return prior;
        // A pending provider dispatch may have succeeded even if its reply was lost.
        // Keep that capacity held across day boundaries and cold restarts.
        for (const { budget, amount: reserveAmount, readUsed } of estimates) {
          const counted = typeof readUsed === 'function' ? readUsed() : readUsed;
          if (counted?.retry) return { retry: true };
          const amount = Number(counted ?? 0) + Number(sql.exec(
            "SELECT COALESCE(SUM(amount), 0) AS amount FROM model_call_reservation_amounts WHERE day = ? AND budget_id = ? AND (? = 0 OR owner = ?) AND (? = 0 OR purpose = ?) LIMIT 1",
            day, budget.id, account ? 0 : 1, owner, budget.per === 'purpose' ? 1 : 0, purpose).toArray()[0]?.amount ?? 0);
          if (amount + reserveAmount > budget.most) return { refused: { budget, amount } };
        }
        sql.exec("INSERT INTO model_call_reservations (id, day, purpose, model, amount, owner, state, created_at,dispatch_identity) VALUES (?, ?, ?, ?, 1, ?, 'pending', ?,?)", id, day, purpose, model, owner, Date.now(),binding);
        for (const { budget, amount } of estimates) sql.exec('INSERT INTO model_call_reservation_amounts (id, budget_id, day, purpose, owner, amount) VALUES (?, ?, ?, ?, ?, ?)', id, budget.id, day, purpose, owner, amount);
        return { id };
      });
      return result.retry ? this.reserve({id, day, purpose, model, owner, input }) : result;
    },
    release(id) {
      if (!id) return { released: true };
      return transaction(() => {
        const row = sql.exec('SELECT state, settlement_json FROM model_call_reservations WHERE id = ? LIMIT 1', id).toArray()[0];
        if (!row) return { released: true };
        if (row.state !== 'pending' || row.settlement_json !== null) return { released: false, reason: 'reservation_already_advanced' };
        sql.exec('DELETE FROM model_call_reservation_amounts WHERE id = ?', id);
        sql.exec('DELETE FROM model_call_reservations WHERE id = ? AND state = \'pending\' AND settlement_json IS NULL', id);
        return { released: sql.exec('SELECT id FROM model_call_reservations WHERE id = ? LIMIT 1', id).toArray().length === 0 };
      });
    },
    cancel(id) {
      if (!id) return { released: true };
      return transaction(() => {
        // An admission RPC can still finish after its caller loses the reply. The closure
        // makes a later transaction for this exact id observe cancellation before insert.
        sql.exec('INSERT OR IGNORE INTO model_call_reservation_closures (id, closed_at) VALUES (?, ?)', id, Date.now());
        const current = sql.exec('SELECT state, settlement_json FROM model_call_reservations WHERE id = ? LIMIT 1', id).toArray()[0];
        if (current && (current.state !== 'pending' || current.settlement_json !== null)) return { released: false, reason: 'reservation_already_advanced' };
        sql.exec('DELETE FROM model_call_reservation_amounts WHERE id = ?', id);
        sql.exec('DELETE FROM model_call_reservations WHERE id = ? AND state = \'pending\' AND settlement_json IS NULL', id);
        const remains = sql.exec('SELECT id FROM model_call_reservations WHERE id = ? LIMIT 1', id).toArray()[0];
        return remains ? { released: false, reason: 'reservation_already_advanced' } : { released: true };
      });
    },
    settle(id, { day, purpose, model, owner = null, usage = {}, rows = null, accounted = [] } = {}) {
      if (!id) return;
      return transaction(() => {
        const held = sql.exec("SELECT * FROM model_call_reservations WHERE id = ? AND state = 'pending' LIMIT 1", id).toArray()[0];
        if (!held) return;
        if (held.day !== day || held.purpose !== purpose || held.model !== model || held.owner !== owner) throw new Error('The model result does not match its reservation.');
        if (account && rows) {
          reconcile({ day, owner, rows, accounted });
        } else if (account) {
          sql.exec(`INSERT INTO model_spend_people (day, person, purpose, model, paid_by, calls, refused, remembered, input_tokens, output_tokens)
            VALUES (?, ?, ?, ?, 'trillion', 1, 0, 0, ?, ?)
            ON CONFLICT (day, person, purpose, model) DO UPDATE SET calls = calls + 1,
            input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
          day, owner, purpose, model, usage.input_tokens ?? 0, usage.output_tokens ?? 0);
        }
        sql.exec('DELETE FROM model_call_reservation_amounts WHERE id = ?', id);
        sql.exec('DELETE FROM model_call_reservations WHERE id = ?', id);
      });
    },
  };
}
