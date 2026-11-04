import { autoEditLines } from '../../media-composition/read-data/auto-edit.mjs';
import editRules from '../../media-composition/read-data/suggestion-stream.json' with { type: 'json' };

// The Media reads used by every AI and client. They reach the same person-scoped
// library and suggestion owners that the workspace uses. Searching them is the one search tool (src/file-tools.mjs `search`).
const MAX_MEDIA_REPLY_BYTES = 200_000;

export const mediaTools = call => [
  { name: 'list_media', description: 'Lists a recent-first page of this person\'s recordings and media made by their tools, with file identity, playback address, measured duration, title, transcript word count, edit use, and kept facts. Pass next_after as after and revision from the earlier page to continue; if the library changed, the first page is returned with reset: true. Filter by whether the original is stored, where it came from, or whether an edit uses it. Continue through pages when every media row is needed. Use search with sources ["files"] to find media by words, and find_file for an exact file name. An unknown duration is null; never invent clip end times.', inputSchema: { type: 'object', properties: {
    after: { type: 'string' }, revision: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 60 },
    stored: { type: 'boolean' }, origin: { type: 'string' }, unused: { type: 'boolean' },
  } }, run: async ({ after, revision, limit, stored, origin, unused, all } = {}) => {
    if (all === true) throw new Error('Read the media library in pages. Call list_media with after and revision from the previous page.');
    const query = new URLSearchParams({ limit: String(limit ?? 20), previews: 'false' });
    if (after !== undefined) query.set('after', after);
    if (revision !== undefined) query.set('revision', revision);
    if (stored !== undefined) query.set('stored', String(stored));
    if (origin !== undefined) query.set('origin', origin);
    if (unused !== undefined) query.set('unused', String(unused));
    const answer = await call(`/media/library?${query}`);
    const written = JSON.stringify(answer);
    if (typeof written !== 'string' || new TextEncoder().encode(written).length > MAX_MEDIA_REPLY_BYTES)
      throw new Error('This media page is too large. Call list_media with a smaller limit, or use search or find_file.');
    return answer;
  } },
  { name: 'next_media_edit', description: 'Reads the same next-edit suggestion the person sees in Media: which real clips to use, their measured lengths, why, and the chosen destination. It changes nothing and runs no render. Use run_tool with the media-composition tools to make the edit.', inputSchema: { type: 'object', properties: {} }, run: () => call('/media/next-edit') },
  { name: 'suggest_media_cuts', description: 'Suggests cuts for one recording from the words it kept (its transcript with word times): mode silent_pauses finds the long silences, filler_words the filler words, and the modes are listed in modes. Answers the typed lines the suggestion went through (status, thinking, then complete with the proposals, each a remove-span with start, end and reason, or an error line with a code such as NO_TRANSCRIPT or NO_PROPOSALS) and the proposals. A suggestion is kept for the recording, the mode and the version of the rules that made it, so asking again is free until the rules change. It changes no edit and renders nothing; apply a proposal with the media editor.', inputSchema: { type: 'object', required: ['identity'], properties: { identity: { type: 'string', description: 'The recording\'s content identity (1f: then 64 hex)' }, mode: { type: 'string', description: 'One of the modes this tool lists (default silent_pauses)' } } }, run: async ({ identity, mode = 'silent_pauses' }) => {
    if (typeof identity !== 'string' || !/^(1f|12):[0-9a-f]{64}$/u.test(identity)) throw new Error('Name the recording by its content identity (1f: then 64 hex).');
    const at = `/namespace/results/${encodeURIComponent(identity)}`;
    const valueOf = answer => (Array.isArray(answer?.results) ? answer.results[0]?.value : answer?.value) ?? null;
    const transcript = valueOf(await call(`${at}?kind=transcript`));
    const kept = valueOf(await call(`${at}?kind=cut-suggestions`)) ?? {};
    const cache = { get: id => kept[id], set: (id, entry) => call(`${at}/merge`, { kind: 'cut-suggestions', value: { [id]: entry }, produced_by: 'suggest_media_cuts' }) };
    const lines = [];
    for await (const line of autoEditLines({ identity, mode, transcript, cache })) lines.push(line);
    const done = lines.find(line => line.type === 'complete');
    return { identity, mode, modes: Object.keys(editRules.modes), lines, proposals: done?.proposals ?? [] };
  } },
];

export const mediaAnnotations = {
  list_media: { title: 'List my media', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  suggest_media_cuts: { title: 'Suggest cuts for a recording', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  next_media_edit: { title: 'Read my next edit suggestion', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
