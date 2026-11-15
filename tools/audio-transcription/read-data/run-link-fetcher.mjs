/** Runs one fetcher command (a row's `info`, `captions` or `sound`), its words filled; stdout, or throws its last line. */
export const createLinkFetcher = ({ execFile, fill }) => (row, part, values, seconds, confine = null, runConfined = null) => {
  const [first, ...args] = row[part].map(word => fill(word, values));
  const command = row.program && first === row.check[0] ? row.program : first;
  const failure = (error, stderr = error.stderr) => new Error((String(stderr ?? '').trim().split('\n').filter(line => !/^WARNING/.test(line)).pop() || error.message).replace(/^ERROR:\s*/, ''));
  // With the DATA switch on, the caller supplies the current constrained runner for this run's folder.
  if (confine?.enabled === true) {
    if (typeof runConfined !== 'function') return Promise.reject(new Error('Confinement was requested; provide the current constrained process runner.'));
    return runConfined(command, args, { tier: confine.tier, workspace: values.folder, timeout_ms: seconds * 1000, scoped_env: row.env ?? {} }).then(done => done.stdout, error => { throw failure(error); });
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, { env: row.env, maxBuffer: 64 * 1024 * 1024, timeout: seconds * 1000 }, (error, stdout, stderr) => {
      if (error) return reject(failure(error, stderr));
      resolve(String(stdout));
    });
  });
};
