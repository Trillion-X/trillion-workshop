import React from 'react';
import { X } from 'lucide-react';
import {
  rankTranscriptSearchResults,
  transcriptSegmentsForSpeaker,
  transcriptSpeakers,
  type TranscriptEntry,
  type TranscriptSegment,
  type TranscriptSemanticMatch,
  type TranscriptWord,
} from '../read-data/read-transcript-records';
import { Dropdown } from '../../ui/show/dropdown';
import { Button, Container, Input, NamedIcon } from '../../ui';
import words from './transcript-tools.json' with { type: 'json' };
import languages from './transcript-languages.json' with { type: 'json' };

// Auto-follow scrolls the active word into view during playback, but a manual
// scroll DISENGAGES it durably so it never fights the user. It re-engages only
// when the user clicks a word/segment. (No timer — a timed resume would yank the
// viewport back down a second after you scroll up.)

function stopTranscriptEvent(event: React.SyntheticEvent) {
  event.stopPropagation();
}

/** What a note's transcript can do with its words. Each tool shows only when its handler is given. */
export type TranscriptTools = {
  /** Name every passage of `speaker` as `name`; `name` null takes the name back to the original label. */
  onNameSpeaker?: (speaker: string, name: string | null) => void | Promise<void>;
  /** Whether `speaker` carries a name the person gave, so it can be taken back. */
  canTakeBack?: (speaker: string) => boolean;
  /** Copy a link that opens the recording at this second. */
  onCopyMoment?: (seconds: number) => void | Promise<void>;
  /** Split the passage into two just before its word number `wordIndex`. */
  onSplit?: (segment: TranscriptSegment, wordIndex: number) => void | Promise<void>;
  onCopy?: () => void | Promise<void>;
  onExportPdf?: () => void | Promise<void>;
  /** Hear the recording again in this language (ISO code and the name shown). */
  onReprocess?: (language: { code: string; label: string }) => void | Promise<void>;
};

const said = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

function AddName({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = React.useState('');
  const add = () => { if (name.trim()) { onAdd(name.trim()); setName(''); } };
  return (
    <Container layout="horizontal" gap="xs" alignItems="center" padding="xs">
      <Input aria-label={words.speaker.search} placeholder={words.speaker.search} value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } event.stopPropagation(); }} />
      <Button size="xs" variant="secondary" aria-label={words.speaker.add_aria} disabled={!name.trim()} onClick={add}>{words.speaker.add}</Button>
    </Container>
  );
}

export type TranscriptReaderSurfaceProps = {
  /** Note tools: rename a speaker, copy a moment's link, split a passage, copy, export, reprocess. */
  tools?: TranscriptTools;
  currentTimeSeconds?: number;
  entry?: TranscriptEntry;
  /** Ordered results from meaning-search, mapped to this transcript's segment ids. */
  semanticMatches?: readonly TranscriptSemanticMatch[];
  /** Lets the embedding owner query meaning-search and provide its ordered matches. */
  onSearchQueryChange?: (query: string) => void | Promise<void>;
  onSelectSegment?: (segment: TranscriptSegment) => void | Promise<void>;
  onSelectTime?: (seconds: number, segment: TranscriptSegment) => void | Promise<void>;
  segments: readonly TranscriptSegment[];
  title?: string;
  /** Words chosen as one stretch, in the media's own seconds; those words are shown chosen. */
  selectedRange?: { start: number; end: number } | null;
  /** When set, clicking a word chooses it and shift-clicking another extends the choice to it. */
  onSelectRange?: (range: { start: number; end: number }) => void;
};

function wordIsChosen(word: TranscriptWord, range?: { start: number; end: number } | null) {
  return Boolean(range) && word.start >= range!.start - 0.001 && word.end <= range!.end + 0.001;
}

function formatOffset(milliseconds?: number) {
  if (typeof milliseconds !== 'number') return '';
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

function segmentStartSeconds(segment: TranscriptSegment) {
  return typeof segment.start_ms === 'number' ? segment.start_ms / 1000 : 0;
}

function segmentIsActive(segment: TranscriptSegment, currentTimeSeconds?: number) {
  if (typeof currentTimeSeconds !== 'number') return false;
  const currentMs = currentTimeSeconds * 1000;
  return typeof segment.start_ms === 'number'
    && typeof segment.end_ms === 'number'
    && currentMs >= segment.start_ms
    && currentMs <= segment.end_ms;
}

function wordIsActive(word: TranscriptWord, currentTimeSeconds?: number) {
  return typeof currentTimeSeconds === 'number'
    && currentTimeSeconds >= word.start
    && currentTimeSeconds < word.end;
}

function activeWordIndex(segment: TranscriptSegment, currentTimeSeconds?: number) {
  if (!segment.words?.length || !segmentIsActive(segment, currentTimeSeconds) || typeof currentTimeSeconds !== 'number') return -1;
  const exactIndex = segment.words.findIndex((word) => wordIsActive(word, currentTimeSeconds));
  if (exactIndex >= 0) return exactIndex;
  for (let index = segment.words.length - 1; index >= 0; index -= 1) {
    if (currentTimeSeconds >= segment.words[index].end) return index;
  }
  return -1;
}

function searchParts(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(${escaped})`, 'ig');
  const normalizedQuery = query.toLowerCase();
  return text.split(pattern).map((part, index) => (
    part.toLowerCase() === normalizedQuery
      ? <mark className="rounded bg-[var(--glass-bg-hover)] px-0.5 text-[var(--text-strong)]" key={`${part}-${index}`}>{part}</mark>
      : <React.Fragment key={`${part}-${index}`}>{part}</React.Fragment>
  ));
}

export function TranscriptReaderSurface({
  currentTimeSeconds,
  entry,
  semanticMatches = [],
  onSearchQueryChange,
  onSelectSegment,
  onSelectTime,
  segments,
  title = 'Transcript',
  selectedRange,
  onSelectRange,
  tools,
}: TranscriptReaderSurfaceProps) {
  // The word the person last chose is the caret a split falls before.
  const [caret, setCaret] = React.useState<{ segment: string; word: number } | null>(null);
  const splitAtCaret = React.useCallback(() => {
    const target = caret ? segments.find((segment) => segment.id === caret.segment) : undefined;
    if (!caret || !target || !tools?.onSplit) return;
    setCaret(null);
    void tools.onSplit(target, caret.word);
  }, [caret, segments, tools]);
  React.useEffect(() => {
    if (!caret || !tools?.onSplit) return undefined;
    const press = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (event.key === 'Enter' && !typing && !event.defaultPrevented) { event.preventDefault(); splitAtCaret(); }
    };
    document.addEventListener('keydown', press);
    return () => document.removeEventListener('keydown', press);
  }, [caret, splitAtCaret, tools?.onSplit]);
  const anchorRef = React.useRef<{ start: number; end: number } | null>(null);
  function chooseWord(word: TranscriptWord, extend: boolean) {
    if (!onSelectRange) return;
    const anchor = extend && anchorRef.current ? anchorRef.current : { start: word.start, end: word.end };
    if (!extend) anchorRef.current = anchor;
    onSelectRange({ start: Math.min(anchor.start, word.start), end: Math.max(anchor.end, word.end) });
  }
  const [searchQuery, setSearchQuery] = React.useState('');
  const [selectedSpeaker, setSelectedSpeaker] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLOListElement | null>(null);
  const autoFollowPausedRef = React.useRef(false);
  const speakers = React.useMemo(() => transcriptSpeakers(segments), [segments]);
  const speakerItems = React.useMemo(() => [
    { value: 'all-speakers', label: 'All speakers' },
    ...speakers.map((speaker) => ({ value: `speaker:${speaker}`, label: speaker })),
  ], [speakers]);
  React.useEffect(() => {
    if (selectedSpeaker && !speakers.includes(selectedSpeaker)) setSelectedSpeaker(null);
  }, [selectedSpeaker, speakers]);
  const activeSegmentIndex = React.useMemo(
    () => segments.findIndex((segment) => segmentIsActive(segment, currentTimeSeconds)),
    [currentTimeSeconds, segments],
  );
  const filteredSegments = React.useMemo(
    () => rankTranscriptSearchResults(transcriptSegmentsForSpeaker(segments, selectedSpeaker), searchQuery, semanticMatches),
    [searchQuery, segments, selectedSpeaker, semanticMatches],
  );

  React.useEffect(() => {
    if (searchQuery || autoFollowPausedRef.current) return;
    const active = scrollRef.current?.querySelector('[data-transcript-word-active="true"], [data-active-segment="true"]') as HTMLElement | null;
    active?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeSegmentIndex, currentTimeSeconds, searchQuery]);

  function pauseAutoFollow() {
    autoFollowPausedRef.current = true;
  }

  function selectTime(seconds: number, segment: TranscriptSegment) {
    autoFollowPausedRef.current = false;
    if (onSelectTime) {
      void onSelectTime(seconds, segment);
      return;
    }
    void onSelectSegment?.(segment);
  }

  function segmentIsSelectable() {
    return Boolean(onSelectSegment || onSelectTime);
  }

  function updateSearchQuery(query: string) {
    setSearchQuery(query);
    void onSearchQueryChange?.(query);
  }

  function renderWords(segment: TranscriptSegment) {
    if (!segment.words?.length) return searchParts(segment.text, searchQuery);
    const highlightedWordIndex = activeWordIndex(segment, currentTimeSeconds);
    return segment.words.map((word, index) => {
      const active = index === highlightedWordIndex;
      const past = highlightedWordIndex >= 0 && index < highlightedWordIndex;
      const matchesSearch = searchQuery.length > 0 && word.word.toLowerCase().includes(searchQuery.toLowerCase());
      const chosen = wordIsChosen(word, selectedRange);
      return (
        <React.Fragment key={`${segment.id}:${index}:${word.start}`}>
          <button
            className={[
              'm-0 inline min-h-0 min-w-0 cursor-pointer appearance-none rounded-sm border-0 p-0 text-left align-baseline font-[inherit] leading-[inherit] tracking-normal transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)]',
              active ? 'bg-[var(--glass-bg-hover)] text-[var(--text-strong)]' : past ? 'text-[var(--text-primary)] hover:bg-[var(--glass-bg-hover)]' : 'text-[var(--text-secondary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]',
              matchesSearch && !active ? 'bg-[var(--glass-bg-subtle)] text-[var(--text-primary)]' : '',
              chosen ? 'bg-[color-mix(in_srgb,var(--accent-primary)_20%,transparent)] text-[var(--text-strong)]' : active ? '' : 'bg-transparent',
            ].filter(Boolean).join(' ')}
            aria-pressed={onSelectRange ? chosen : undefined}
            data-transcript-word={word.word}
            data-transcript-word-active={active ? 'true' : 'false'}
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              autoFollowPausedRef.current = false;
              chooseWord(word, event.shiftKey);
              setCaret({ segment: segment.id, word: index });
              selectTime(word.start, segment);
            }}
            onPointerDown={stopTranscriptEvent}
          >
            {word.word}
          </button>{' '}
        </React.Fragment>
      );
    });
  }

  return (
    <section
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)]"
      data-package="transcript-reader"
      data-surface="transcript-reader"
      data-testid="transcript-reader-surface"
      onClick={(event) => event.stopPropagation()}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-primary)] px-3 py-2">
        <h2 className="m-0 shrink-0 text-sm font-medium text-[var(--text-primary)]">{entry?.label ?? title}</h2>
        {speakers.length > 1 ? (
          <Dropdown
            aria-label="Filter transcript by speaker"
            header="Speakers in this recording"
            items={speakerItems}
            onValueChange={(value) => setSelectedSpeaker(value === 'all-speakers' ? null : value.slice('speaker:'.length))}
            scrollable
            value={selectedSpeaker ? `speaker:${selectedSpeaker}` : 'all-speakers'}
          />
        ) : null}
        <label className="block min-w-[9rem] flex-1">
          <span className="sr-only">Search transcript</span>
          <span className="relative block">
            <input
              className="h-8 w-full rounded-md border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-2.5 pr-8 text-sm text-[var(--text-primary)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--border-focus)] focus:bg-[var(--glass-bg-hover)]"
              placeholder="Search transcript..."
              type="text"
              value={searchQuery}
              onChange={(event) => updateSearchQuery(event.currentTarget.value)}
            />
            {searchQuery ? (
              <button
                aria-label="Clear transcript search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-muted)] transition hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]"
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  updateSearchQuery('');
                }}
                onPointerDown={stopTranscriptEvent}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </span>
        </label>
        {tools?.onCopy || tools?.onExportPdf || tools?.onReprocess ? (
          <Dropdown
            aria-label={words.more}
            align="end"
            scrollable
            searchable
            searchLabel={words.reprocess.search}
            customTrigger={<Button size="sm" variant="ghost" aria-label={words.more}>{words.tools_label}</Button>}
            items={[
              ...(tools.onCopy ? [{ value: 'copy', label: words.copy.label, icon: 'Copy' }] : []),
              ...(tools.onExportPdf ? [{ value: 'pdf', label: words.pdf.label, icon: 'FileDown' }] : []),
              ...(tools.onReprocess ? [{ value: 'reprocess', label: words.reprocess.label, icon: 'Languages',
                children: languages.languages.map((language) => ({ value: `language:${language.code}`, label: language.label })) }] : []),
            ]}
            value=""
            onValueChange={(value) => {
              if (value === 'copy') void tools.onCopy?.();
              else if (value === 'pdf') void tools.onExportPdf?.();
              else if (value.startsWith('language:')) {
                const language = languages.languages.find((row) => `language:${row.code}` === value);
                if (language) void tools.onReprocess?.(language);
              }
            }}
          />
        ) : null}
      </header>
      {segments.length > 0 ? (
        <ol
          className="screen-edge-fade m-0 min-h-0 flex-1 list-none overflow-y-auto px-2 py-2"
          data-testid="transcript-segments"
          ref={scrollRef}
          onPointerDown={pauseAutoFollow}
          onTouchMove={pauseAutoFollow}
          onWheel={pauseAutoFollow}
        >
          {filteredSegments.map((segment) => {
            const active = segmentIsActive(segment, currentTimeSeconds);
            const offset = formatOffset(segment.start_ms);
            return (
            <li
              className={[
                'm-0 grid grid-cols-[2.75rem_minmax(0,1fr)] items-baseline gap-x-2 rounded-md px-2 py-1 text-sm leading-6 transition-colors',
                active ? 'bg-[var(--glass-bg-hover)]' : 'hover:bg-[var(--glass-bg-subtle)]',
              ].join(' ')}
              data-active-segment={active ? 'true' : 'false'}
              data-record-id={segment.id}
              data-record-ref={segment.transcript_ref}
              data-transcript-segment={segment.id}
              data-testid="transcript-segment"
              key={segment.id}
            >
              <button
                aria-label={offset ? `Play from ${offset}` : 'Play from here'}
                className="m-0 min-h-0 min-w-0 cursor-pointer appearance-none border-0 bg-transparent p-0 text-left font-[inherit] text-xs tabular-nums leading-6 text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--border-focus)] disabled:cursor-default"
                data-testid="transcript-segment-action"
                disabled={!segmentIsSelectable()}
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  selectTime(segmentStartSeconds(segment), segment);
                }}
                onPointerDown={stopTranscriptEvent}
              >
                {offset}
              </button>
              <p className={['m-0 min-w-0 break-words', active ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'].join(' ')}>
                {segment.speaker ? (tools?.onNameSpeaker ? (
                  <Dropdown
                    aria-label={said(words.speaker.open, { speaker: segment.speaker })}
                    header={words.speaker.heading}
                    searchable
                    searchLabel={words.speaker.search}
                    scrollable
                    customTrigger={<Button size="xs" variant="ghost">{segment.speaker}:</Button>}
                    items={[
                      ...speakers.filter((name) => name !== segment.speaker).map((name) => ({ value: `name:${name}`, label: name, icon: 'UserRound' })),
                      ...(tools.canTakeBack?.(segment.speaker) ? [{ value: 'take-back', label: words.speaker.take_back, icon: 'Undo2' }] : []),
                    ]}
                    value=""
                    footer={<AddName onAdd={(name) => { void tools.onNameSpeaker?.(segment.speaker!, name); }} />}
                    onValueChange={(value) => {
                      if (value === 'take-back') void tools.onNameSpeaker?.(segment.speaker!, null);
                      else if (value.startsWith('name:')) void tools.onNameSpeaker?.(segment.speaker!, value.slice('name:'.length));
                    }}
                  />
                ) : <strong className="mr-1 font-medium text-[var(--text-primary)]">{segment.speaker}:</strong>) : null}
                {renderWords(segment)}
                {tools?.onCopyMoment ? (
                  <Button size="xs" variant="ghost" aria-label={said(words.moment.copy, { time: offset || '0:00' })}
                    onClick={() => { void tools.onCopyMoment?.(segmentStartSeconds(segment)); }}>
                    <NamedIcon name="Link" size="sm" aria-hidden="true" />
                  </Button>
                ) : null}
                {tools?.onSplit && caret?.segment === segment.id && caret.word > 0 ? (
                  <Button size="xs" variant="secondary" aria-label={words.split.aria} onClick={splitAtCaret}>{words.split.label} {words.split.hint}</Button>
                ) : null}
              </p>
            </li>
          );})}
        </ol>
      ) : (
        <div className="m-3 text-sm text-[var(--text-secondary)]">
          {segments.length === 0
            ? 'No transcript yet.'
            : selectedSpeaker
              ? `No passages from ${selectedSpeaker} match this search.`
              : 'No transcript passages match this search.'}
        </div>
      )}
    </section>
  );
}
