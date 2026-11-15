// The worker adapter: retain isolated Python, no bytecode, and the v7 snapshot tree contract.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLASSIFIER_WORKER = fileURLToPath(new URL('../do-work/run_classifier.py', import.meta.url));

export function startClassifier(action, request, { python = 'python3', worker = CLASSIFIER_WORKER } = {}) {
  const child = spawn(python, ['-I', '-B', worker, action], { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(request));
  return child;
}
