// Any connected AI can connect a grounded file description to one recorded pursuit. MIME folders and names
// remain evidence-based and reversible; no model guesses what opaque bytes contain.
import { explicitChoiceReply, explicitChoiceRequest } from './local-choice.mjs';

const words = value => new Set(String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

export function filePursuitOptions(organization, pursuits) {
  const fileWords = words([organization.title, ...(organization.tags ?? [])].join(' '));
  const ranked = (Array.isArray(pursuits) ? pursuits : []).filter(row => row?.status !== 'ended' && row?.id && row?.title)
    .map(row => ({ row, overlap: [...words(row.title)].filter(word => fileWords.has(word)).length }))
    .sort((a, b) => b.overlap - a.overlap || a.row.title.localeCompare(b.row.title))
    .slice(0, 15);
  const mapping = new Map(ranked.map(({ row }, index) => [`p${index + 1}`, row.id]));
  return { mapping, candidates: [
    ...ranked.map(({ row }, index) => ({ id: `p${index + 1}`, label: row.title, description: [row.now, row.after].filter(Boolean).join(' ').slice(0, 400) })),
    { id: 'none', label: 'No supported pursuit', description: 'The file evidence does not support linking it to any listed pursuit.' },
  ] };
}

export async function chooseFilePursuit({ organization, pursuits, summary = '', ask }) {
  if (organization?.status !== 'grounded') return { skipped: 'The file has no extracted description yet.' };
  const { mapping, candidates } = filePursuitOptions(organization, pursuits);
  if (!mapping.size) return { skipped: 'No recorded pursuits.' };
  const question = explicitChoiceRequest({ state: JSON.stringify({ title: organization.title, category: organization.category,
    tags: organization.tags, summary: String(summary).slice(0, 500) }),
    criteria: 'Link the file only when its own description directly supports the pursuit. Choose none for a guess or weak resemblance.', candidates });
  const answered = await ask(question.input);
  const result = explicitChoiceReply(answered?.reply, question.candidates);
  if (!result) return null;
  return { pursuit: mapping.get(result.choice) ?? null, reason: result.reason, model: answered.model ?? result.model };
}
