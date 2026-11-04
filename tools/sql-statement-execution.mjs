// A statement refusal belongs to one synchronous exec call on one SQL handle. Error codes (and even Error
// identities) can be reused after real execution, so neither proves that SQLite was never called.
const refused = new WeakMap();
// Transparent SQL proxies forward this getter. The global symbol also survives separately bundled native hosts.
export const SQL_STATEMENT_EXECUTION = Symbol.for('trillion.sql.statement-execution');
export const sqlStatementExecutionWitness = handle => error => refused.has(handle) && refused.get(handle) === error;

export function beginSqlStatement(handle) { refused.delete(handle); }
export function refuseSqlStatementBeforeExecution(handle, error) { refused.set(handle, error); }
export function sqlStatementWasNotExecuted(handle, error) {
  const witness = handle[SQL_STATEMENT_EXECUTION];
  return typeof witness === 'function' && witness(error);
}
