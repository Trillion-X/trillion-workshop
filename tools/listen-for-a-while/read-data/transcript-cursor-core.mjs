// The original sequence filter; the row adapter supplies its ledger through rows.readLedger.
const data = Object.freeze({ readLedger: listen => listen });
const readLedger = (listen, rows) => rows.readLedger(listen);
export const linesSince = (listen, seq, rows = data) => readLedger(listen, rows).filter(line => line.seq > seq);
