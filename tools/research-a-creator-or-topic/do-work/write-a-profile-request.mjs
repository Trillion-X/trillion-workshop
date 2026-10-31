// tools/research-a-creator-or-topic/do-work/write-a-profile-request.mjs
//
// Turns what was gathered about a creator or a topic (a video's words, a page's text) into the instruction a model
// writes a profile from: the person's own wording of what to look for, then the material. Run by the Workshop tool
// `tool:write-a-profile-request` in the tool container:
//
//   node do-work/write-a-profile-request.mjs < {"subject_ref": "...", "instruction": "...", "evidence": [{"id": "...", "text": "..."}]}
//
// It asks no model and keeps nothing: the person's AI writes the profile from `instruction_text` and keeps it in the
// person's own records. Prints { subject_ref, profile_ref, skipped, requests: [...] } on its last line.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const required = (value, field, hint) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Send ${field}: ${hint}`);
  return value;
};

export function writeAProfileRequest(input) {
  const subject = required(input?.subject_ref, 'subject_ref', 'who or what is being profiled (a handle, a link or a topic).').trim();
  const instruction = required(input?.instruction, 'instruction', 'the words telling the writer what to look for in the material. Its text comes before the material.');
  const material = [];
  if (typeof input.material === 'string' && input.material.trim()) material.push({ id: '', text: input.material });
  for (const entry of Array.isArray(input.evidence) ? input.evidence : []) {
    if (entry && typeof entry.text === 'string' && entry.text.trim()) material.push({ id: String(entry.id ?? ''), text: entry.text });
  }
  if (material.length === 0) throw new Error('Send material (words) or evidence ([{ id, text }]): there is nothing to profile yet.');
  const profile = typeof input.profile_ref === 'string' && input.profile_ref.trim() ? input.profile_ref.trim() : `profile:${subject}`;
  const outputKind = typeof input.output_kind === 'string' && input.output_kind.trim() ? input.output_kind.trim() : 'profile';
  const skipped = (Array.isArray(input.evidence) ? input.evidence : [])
    .filter(entry => !(entry && typeof entry.text === 'string' && entry.text.trim())).map(entry => String(entry?.id ?? ''));
  return {
    subject_ref: subject,
    profile_ref: profile,
    skipped,
    requests: material.map(({ id, text }) => ({
      kind: 'profile-request', status: 'requested', request_id: id ? `${subject}:${id}` : subject, profile_ref: profile,
      subject_ref: subject, output_kind: outputKind, instruction_text: instruction + text,
    })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(writeAProfileRequest(JSON.parse(readFileSync(0, 'utf8') || '{}')))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 2;
  }
}
