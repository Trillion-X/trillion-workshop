// Source-owned narration adapter. Voice lookup, reference recovery and synthesis
// stay with computer/speak.mjs; a film may require the requested voice exactly.
import { sayHere } from '../../../../computer/speak.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const request = JSON.parse(input);
  if (typeof request.voice !== 'string' || !request.voice.trim()) throw new Error('An exact existing voice id is required.');
  const answer = await sayHere(request, { allowFallback: false });
  if (answer.voice.id !== request.voice) throw new Error('Speaker returned a different voice.');
  process.stdout.write(`${JSON.stringify(answer)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
