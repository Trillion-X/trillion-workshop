// tools/research-a-creator-or-topic/do-work/fetch-text.mjs
//
// One public page as text. Where the request may go is not decided here: the engine runs the commands that use this as
// internet:true, so Node's own fetch reaches only the engine's public-only proxy, which judges every address, every
// redirect and every address a name resolves to. This only keeps to http and https, to a size and to a time.

const MAX_BYTES = 2_000_000;
const WAIT_MS = 15_000;

export async function fetchText(address, { accept = 'text/html,application/xml;q=0.9,*/*;q=0.5', fetchPage = fetch } = {}) {
  let url;
  try { url = new URL(address); } catch { throw new Error('Send an absolute http or https address.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses can be read.');
  let response;
  try {
    response = await fetchPage(url, { redirect: 'follow', signal: AbortSignal.timeout(WAIT_MS), headers: { accept, 'user-agent': 'ResearchReader/1.0' } });
  } catch { throw new Error('The address could not be reached.'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The address answered HTTP ${response.status}.`); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel(); throw new Error('The answer is larger than the 2 MB limit.'); }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new Error('The answer is larger than the 2 MB limit.');
      chunks.push(chunk);
    }
  } catch (error) { throw error.message.includes('2 MB') ? error : new Error('The answer could not be read.'); }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}
