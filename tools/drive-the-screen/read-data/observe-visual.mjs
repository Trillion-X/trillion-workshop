export const run = (program, args, { input = null, timeout = 90_000, maxBuffer = 24 * 1024 * 1024 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks = [], errors = [];
  let bytes = 0;
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxBuffer) child.kill('SIGTERM'); else chunks.push(chunk); });
  child.stderr.on('data', chunk => errors.push(chunk));
  child.on('error', reject);
  child.on('close', code => { clearTimeout(timer); if (code || bytes > maxBuffer) reject(new Error(Buffer.concat(errors).toString().trim() || 'visual reader failed')); else resolve(Buffer.concat(chunks)); });
  if (input?.pipe) input.pipe(child.stdin);
  else child.stdin.end(input ?? undefined);
});
