// tools/turn-a-finished-decision-into-an-anonymous-public/read-data/write-a-story.mjs
//
// Writes a finished decision as a public story through one privacy pass. Ported from the old app's src/stories.mjs
// (writeStory) and src/private-rewrite.mjs (privateRewrite); the plain pass is the current owner's
// tools/learn-from-everyones-results/read-data/plain-privacy-pass.mjs, not a copy.
//
// The pass, for at most settings.rewrite.rounds tries:
//   1. The facts are redacted (every private term and identifying pattern replaced by the one mark) before any model
//      sees them.
//   2. One model (models.rewrite) writes the story from them.
//   3. The plain pass must find nothing in the story's words (no name inside a sentence, no term, no address, no
//      number of money, no key), then a different model (models.check) must find no identifying detail.
//   4. Anything either finds goes back to the writer, redacted, and the next try runs; after the last try nothing is shared.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No model is imported or named here. `ask(model, system, user, maxTokens)` is the caller's adapter to its platform
//      and resolves to the parsed JSON object of the reply; `models` names the two model ids the caller chose.
//   2. The prompts, the kinds, the words and the checking context are DATA (./story-settings.json).
//   3. A story whose kind the owner keeps private is never written as shared, whatever its words say.
//   4. The refusal names only redacted words; a name never comes back in a reason.
import { readFileSync } from 'node:fs';
import { findings, privateTerms, redact, redactAll } from '../../learn-from-everyones-results/read-data/plain-privacy-pass.mjs';
import { kindOf, storyFacts } from './story-facts.mjs';

const settings = JSON.parse(readFileSync(new URL('./story-settings.json', import.meta.url), 'utf8'));
const text = value => String(value ?? '').trim();
const clip = (value, size) => (value.length > size ? `${value.slice(0, size)}…` : value);

/**
 * The words that must never appear in a story written from this record: the caller's known values (the person's name
 * and contact), the person's own never-publish phrases, the always-private words, and the proper names in the record.
 */
export const storyPrivateTerms = (record, known = [], neverPublish = []) =>
  privateTerms({ known, neverPublish, texts: [storyFacts(record), (record.scratchpad ?? []).map(note => note.text)] });

/**
 * Rewrite `facts` with `prompt` on models.rewrite, shape the reply with `shape` (null when incomplete), and check the
 * result. Resolves to `{ shared: true, entry, rounds }` or `{ shared: false, reason }`.
 */
export async function privateRewrite({ ask, models }, facts, prompt, shape, { terms = new Set(), maxTokens = settings.rewrite.max_tokens, checkContext = '' } = {}) {
  const rounds = settings.rewrite.rounds;
  const checkPrompt = checkContext ? `${settings.prompts.check} ${checkContext}` : settings.prompts.check;
  let input = JSON.stringify(redactAll(facts, terms));
  let found = [];
  for (let round = 0; round < rounds; round += 1) {
    const entry = shape(await ask(models.rewrite, prompt, input, maxTokens));
    if (!entry) return { shared: false, reason: 'The rewrite was incomplete.' };
    // Words written for strangers name no one: anything the plain pass finds goes back to the writer without a model check.
    const plain = findings(entry, terms);
    const checked = plain.length ? { identifying: plain } : await ask(models.check, checkPrompt, JSON.stringify(entry), settings.rewrite.check_max_tokens);
    if (!Array.isArray(checked.identifying)) return { shared: false, reason: 'The privacy check did not answer.' };
    found = checked.identifying.map(String).filter(item => item.trim());
    if (!found.length) return { shared: true, entry, rounds: round + 1 };
    input = JSON.stringify({ rewrite_this: redactAll(entry, terms), remove_these: found.map(item => redact(item, terms)) });
  }
  return { shared: false, reason: `After ${rounds} tries it could still point to you: ${found.slice(0, 5).map(item => redact(item, terms)).join('; ')}` };
}

/**
 * Write `record` as a story. `terms` are the words that must never appear (storyPrivateTerms). `heldKinds` are the kinds
 * the owner keeps private. `thinking` is the caller's list of worked-answer sentences for storyFacts. `words` are the
 * product words the caller passes (held_kind, the sentence a held kind is refused with); none are kept in this tool.
 */
export async function writeStory({ ask, models }, record, { terms = new Set(), heldKinds = [], thinking = [], words } = {}) {
  if (!words?.held_kind) throw new Error('writeStory needs the product words the caller passes (held_kind); none are kept in this tool.');
  const facts = storyFacts(record, { thinking });
  const kinds = settings.kinds.map(kind => `${kind.id} (${kind.label})`).join(', ');
  const prompt = settings.prompts.story.replace('{kinds}', kinds);
  const checked = await privateRewrite({ ask, models }, facts, prompt, reply => {
    const options = (Array.isArray(reply.options) ? reply.options : []).map(text).filter(Boolean).slice(0, 8);
    const story = {
      kind: kindOf(text(reply.kind)),
      title: clip(text(reply.title), 90),
      summary: clip(text(reply.summary), 220),
      situation: text(reply.situation),
      options,
      chosen: text(reply.chosen),
      why: text(reply.why),
      next_step: text(reply.next_step),
      measured_by: text(reply.measured_by),
      outcome: facts.outcome && text(reply.outcome) ? { result: facts.outcome.result, what_happened: text(reply.outcome) } : null,
    };
    return story.title && story.situation && story.chosen && story.why && options.length >= 2 ? story : null;
  }, { terms, maxTokens: settings.rewrite.max_tokens, checkContext: settings.privacy.publisher_context });
  if (!checked.shared) return { shared: false, reason: checked.reason };
  if (heldKinds.includes(checked.entry.kind)) {
    const label = settings.kinds.find(kind => kind.id === checked.entry.kind)?.label ?? '';
    return { shared: false, reason: words.held_kind.replace('{kind}', label.toLowerCase()) };
  }
  return { shared: true, story: checked.entry, rounds: checked.rounds };
}
