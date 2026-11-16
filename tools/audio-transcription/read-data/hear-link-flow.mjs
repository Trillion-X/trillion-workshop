import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fileIn = (folder, stem) => readdirSync(folder).filter(name => name.startsWith(`${stem}.`)).map(name => path.join(folder, name))[0] ?? null;

// Bind the current data, hearing and files owners; the recovered flow owns their order and failure behavior.
export const linkToolsFor = ({ linkSettings, hearingHere, hearWith, runFetcher, captionWords, refusedThisCopy, fill }) => ({
  /**
   * The words said in a video or recording at a link: { url, languages? } -> { url, title, duration_seconds, text,
   * segments, language, heard_whole, source: 'captions' | 'heard', produced_by }. Throws why when there are none.
   */
  async hear(input, _context = {}, { fetchers = null, hearing = undefined, hear = hearWith } = {}) {
    const settings = linkSettings();
    const words = settings.words;
    const url = String(input?.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) throw Object.assign(new Error(words.needs_url), { status: 400 });
    const fetcher = fetchers ? fetchers[0] ?? null : hearingHere(settings.fetchers ?? []);
    if (!fetcher) throw new Error(fill(words.no_fetcher, { url }));
    const folder = mkdtempSync(path.join(os.tmpdir(), 'heard-link-'));
    const values = { url, folder, languages: input.languages ?? settings.languages, node: process.execPath };
    const most = (settings.most_minutes ?? 30) * 60;
    const failed = error => new Error(fill(refusedThisCopy(error) && fetcher.update_hint ? words.stale_fetcher : words.fetch_failed,
      { url, error: String(error?.message ?? error), fetcher: fetcher.label ?? fetcher.id, hint: fetcher.update_hint ?? '' }));
    try {
      let info = {};
      try { info = JSON.parse(await runFetcher(fetcher, 'info', values, most)); } catch (error) { throw failed(error); }
      const about = { url, title: info.title ?? null, duration_seconds: Number.isFinite(info.duration) ? info.duration : null };
      // The page's own captions, when it has them in a language asked for.
      try { await runFetcher(fetcher, 'captions', values, most); } catch { /* no captions: the sound is heard below */ }
      const captions = fileIn(folder, 'captions');
      if (captions) {
        const read = captionWords(readFileSync(captions, 'utf8'));
        if (read.text) {
          const language = path.basename(captions).split('.').slice(-2, -1)[0] ?? null;
          return { ...about, ...read, language, heard_whole: true, source: 'captions', produced_by: words.captions_by };
        }
      }
      // No captions: the sound, heard on this Mac.
      const hearingRow = hearing === undefined ? hearingHere(settings.hearing ?? []) : hearing;
      if (!hearingRow) throw new Error(fill(words.no_hearing, { url }));
      try { await runFetcher(fetcher, 'sound', values, most); } catch (error) { throw failed(error); }
      const sound = fileIn(folder, 'sound');
      if (!sound || !statSync(sound).size) throw failed(new Error('no sound came back'));
      const heard = await hear(hearingRow, sound);
      if (!String(heard?.text ?? '').trim()) throw new Error(fill(words.no_words, { url }));
      return { ...about, text: heard.text, segments: heard.segments ?? [], language: heard.language ?? null, heard_whole: heard.heard_whole !== false, source: 'heard', produced_by: heard.produced_by ?? hearingRow.produced_by };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
});
