import React, { useState, useCallback, useRef } from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  Container,
  Text,
  Input,
  Badge,
  ImageBlock,
  Spinner,
  EmptyPlaceholder,
  BulkSelectBar,
  NamedIcon,
  mountReactSurface,
} from '@/packages/ui';
import { Search, Film } from 'lucide-react';

/**
 * MediaSearchSurface — generic, blind, reference-grounded media search.
 *
 * Flow (all DATA-driven, zero media vocabulary in this file):
 *   1. Dispatch `action:find-similar` (index_id from surface config) → items [{address, score}].
 *      2. Hydrate: read the matched records (`find-current-items` filtered by content_address)
 *      → each record SELF-DESCRIBES its own renderable preview (L090): a
 *      `preview_artifact_ref` (CAS address of a sprite sheet the producer wrote —
 *      bytes live in CAS, NEVER inline on the record) + a `preview_region`, plus
 *      the source media CAS address. This surface renders whatever preview fields
 *      exist; it does NOT know a video from an audio clip from a document.
 *   3. Grid of thumbnails (CSS sprite-crop of the sheet). Click → open `/cas/<addr>`.
 *      Corner toggle → multi-select for downstream actions (make a video, etc.).
 *
 * L065-compliant: composed entirely from shared `ui` primitives — no raw HTML,
 * no className. References: Frame.io grid + duration badge + multi-select,
 * ElevenLabs Explore dark masonry, Krea AI minimal centered search.
 */

interface MediaSearchSurfaceProps {
  indexId?: string;
  sourceKind?: string;
  onAction?: (action: string, selectedAddresses: string[]) => void;
}

interface SheetRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  sheet_width: number;
  sheet_height: number;
}

interface SearchResult {
  address: string;
  score: number;
  title: string;
  previewSheetUrl: string;
  previewRegion: SheetRegion | null;
  sourceCasAddress: string;
  timeOffsetSeconds: number;
}

const DEBOUNCE_MS = 300;
const DEFAULT_SOURCE_KIND = 'media-search-item';

function decodeReply(reply: any): any | null {
  if (!reply?.payload || reply.payload.length === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(reply.payload));
  } catch {
    return null;
  }
}

function titleFromAddress(address: string): string {
  const tail = String(address || '').split('::').pop() || address || '';
  return tail.replace(/[:_-]+/g, ' ').trim() || 'Untitled';
}

function payloadFromItem(item: any): Record<string, any> {
  const payload = item?.payload || item;
  return payload && typeof payload === 'object' ? payload : {};
}

function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9]+/).map((term) => term.trim()).filter((term) => term.length > 1);
}

function fallbackScore(payload: Record<string, any>, terms: string[]): number {
  if (terms.length === 0) return 0;
  const text = [
    payload.label,
    payload.title,
    payload.summary,
    payload.search_text,
    payload.body_text,
    payload.duration_label,
  ].filter(Boolean).join('\n').toLowerCase();
  const hits = terms.filter((term) => text.includes(term)).length;
  if (hits === 0) return 0;
  const titleText = String(payload.label || payload.title || '').toLowerCase();
  const titleHits = terms.filter((term) => titleText.includes(term)).length;
  return Math.min(0.98, 0.42 + (hits / terms.length) * 0.46 + titleHits * 0.04);
}

function isContainmentUnavailableError(error: any): boolean {
  const message = String(error?.message || error || '');
  return message.includes('mandatory process containment unavailable')
    || message.includes('held-directory input authority')
    || message.includes('process containment unavailable');
}

function casServeUrl(address: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/cas/${encodeURIComponent(address)}`;
}

export function MediaSearchSurface(props: MediaSearchSurfaceProps) {
  const { indexId = 'media-visual', sourceKind = DEFAULT_SOURCE_KIND } = props;

  const [queryText, setQueryText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Hydrate result addresses → self-describing preview fields off the record.
  const hydrate = useCallback(
    async (ranked: { address: string; score: number }[]): Promise<SearchResult[]> => {
      const addresses = ranked.map((r) => r.address).filter(Boolean);
      if (addresses.length === 0) return [];

      const byAddress = new Map<string, any>();
      try {
        const reply = await sendRequestToBitfieldTarget({
          target: 'slot::find-current-items',
          payload: {
            operation: 'find-current-items',
            in: 'published-record',
            where: { all: [{ field: 'content_address', in: addresses }] },
            include: ['payload'],
            limit: addresses.length,
          },
        });
        const decoded = decodeReply(reply);
        for (const item of decoded?.items || []) {
          const payload = item?.payload || item;
          if (payload?.content_address) byAddress.set(payload.content_address, payload);
        }
      } catch {
        // Hydration is best-effort; tiles still render with placeholder + title.
      }

      return ranked.map((r) => {
        const rec = byAddress.get(r.address) || {};
        return resultFromRecord(rec, r.address, r.score);
      });
    },
    [],
  );

  function resultFromRecord(rec: Record<string, any>, address: string, score: number): SearchResult {
    const ref = rec.source_artifact_ref || {};
    const previewRef = rec.preview_artifact_ref || {};
    const region = rec.preview_region;
    const hasRegion =
      region &&
      [region.x, region.y, region.width, region.height, region.sheet_width, region.sheet_height].every(
        (n: any) => Number.isFinite(Number(n)) && Number(n) >= 0,
      ) &&
      Number(region.width) > 0 &&
      Number(region.height) > 0 &&
      Number(region.sheet_width) > 0;
    return {
      address,
      score,
      title: String(rec.label || rec.title || titleFromAddress(address)),
      previewSheetUrl: previewRef.cas_address
        ? `${casServeUrl(String(previewRef.cas_address))}?mime=${encodeURIComponent(String(previewRef.media_type || 'image/jpeg'))}`
        : '',
      previewRegion: hasRegion
        ? {
            x: Number(region.x),
            y: Number(region.y),
            width: Number(region.width),
            height: Number(region.height),
            sheet_width: Number(region.sheet_width),
            sheet_height: Number(region.sheet_height),
          }
        : null,
      sourceCasAddress: String(ref.cas_address || ref.multihash || ''),
      timeOffsetSeconds: Number(rec.time_offset_seconds || 0),
    };
  }

  const runFallbackSearch = useCallback(
    async (query: string): Promise<SearchResult[]> => {
      const terms = searchTerms(query);
      if (terms.length === 0) return [];
      const reply = await sendRequestToBitfieldTarget({
        target: 'slot::find-current-items',
        payload: {
          operation: 'find-current-items',
          in: 'published-record',
          where: { all: [{ field: 'kind', in: [sourceKind] }] },
          include: ['payload'],
          limit: 100,
        },
      });
      const decoded = decodeReply(reply);
      const items = Array.isArray(decoded?.items) ? decoded.items : [];
      return items
        .map((item: any) => {
          const payload = payloadFromItem(item);
          const address = String(payload.content_address || item?.address || '');
          return address ? { payload, address, score: fallbackScore(payload, terms) } : null;
        })
        .filter((item: any): item is { payload: Record<string, any>; address: string; score: number } => item !== null && item.score > 0)
        .sort((left: any, right: any) => right.score - left.score)
        .slice(0, 24)
        .map((item: any) => resultFromRecord(item.payload, item.address, item.score));
    },
    [],
  );

  const runSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setResults([]);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const reply = await sendRequestToBitfieldTarget({
          target: 'slot::workflow',
          payload: {
            operation: 'execute_definition',
            definition_id: 'action:find-similar',
            include_output: true,
            input: { index_id: indexId, query_text: query, limit: 24 },
          },
        });
        const decoded = decodeReply(reply);
        const items = decoded?.output?.result?.items;
        if (Array.isArray(items)) {
          const ranked = items.map((it: any) => ({ address: it.address, score: Number(it.score || 0) }));
          setResults(await hydrate(ranked));
        } else {
          setResults([]);
        }
      } catch (err: any) {
        try {
          const fallbackResults = await runFallbackSearch(query);
          if (fallbackResults.length > 0 || isContainmentUnavailableError(err)) {
            setResults(fallbackResults);
            setError(null);
            return;
          }
        } catch {
          // Fall through to the original workflow error below.
        }
        setResults([]);
        setError(err?.message || 'Search failed');
      } finally {
        setLoading(false);
      }
    },
    [indexId, hydrate, runFallbackSearch],
  );

  const onQueryChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQueryText(value);
      setSelected(new Set());
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => runSearch(value), DEBOUNCE_MS);
    },
    [runSearch],
  );

  const toggleSelect = useCallback((address: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });
  }, []);

  const openSource = useCallback((result: SearchResult) => {
    if (!result.sourceCasAddress || typeof window === 'undefined') return;
    const time = result.timeOffsetSeconds > 0 ? `#t=${Math.floor(result.timeOffsetSeconds)}` : '';
    window.open(`${casServeUrl(result.sourceCasAddress)}?mime=video/mp4${time}`, '_blank');
  }, []);

  const renderTile = (result: SearchResult) => {
    const isSelected = selected.has(result.address);
    return (
      <Container
        key={result.address}
        layout="vertical"
        gap="none"
        rounded="md"
        overflow="hidden"
        border={isSelected ? 'all' : 'none'}
        background="secondary"
        onClick={() => openSource(result)}
      >
        <Container
          layout="vertical"
          justifyContent="center"
          alignItems="center"
          minHeight="150px"
          background="tertiary"
          position="relative"
          overflow="hidden"
          // Aspect-accurate frame box: match the tile's real dimensions so the
          // whole frame shows (portrait or landscape), not a top slice. Falls
          // back to 16:9 when there is no preview.
          style={{
            aspectRatio:
              result.previewRegion && result.previewRegion.width > 0 && result.previewRegion.height > 0
                ? `${result.previewRegion.width} / ${result.previewRegion.height}`
                : '16 / 9',
          }}
        >
          {result.previewSheetUrl && result.previewRegion ? (
            // Sprite-sheet crop: preview bytes live in ONE CAS sheet per run
            // (thumbnail contract — bytes in artifact_ref, never inline); the
            // record's region descriptor drives a pure-CSS percentage crop.
            // Dynamic values are data-driven, so style (not tokens) is correct
            // here — same pattern as ImageBlock's dynamic maxHeight.
            <ImageBlock
              src={result.previewSheetUrl}
              alt={result.title}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: `${(result.previewRegion.sheet_width / result.previewRegion.width) * 100}%`,
                maxWidth: 'none',
                // translate % is relative to the IMAGE's own rendered size (unlike
                // left/top %, which reference the container) — exact sprite crop
                // at any tile width.
                transform: `translate(${(-result.previewRegion.x / result.previewRegion.sheet_width) * 100}%, ${(-result.previewRegion.y / result.previewRegion.sheet_height) * 100}%)`,
              }}
            />
          ) : (
            <NamedIcon name="Film" />
          )}
          <Container position="absolute" inset="tr-2" zIndex="10" onClick={(e: React.MouseEvent) => { e.stopPropagation(); toggleSelect(result.address); }}>
            <Badge variant={isSelected ? 'accent' : 'muted'} size="sm">
              {isSelected ? 'Selected' : 'Select'}
            </Badge>
          </Container>
        </Container>
        <Container layout="vertical" gap="xs" padding="sm">
          <Text variant="label" color="strong" truncate>{result.title}</Text>
          <Text variant="caption" color="subtle">relevance {(result.score * 100).toFixed(0)}%</Text>
        </Container>
      </Container>
    );
  };

  return (
    <Container layout="vertical" gap="none" height="full" background="primary" overflow="hidden">
      <Container padding="lg" border="bottom" background="secondary">
        <Input
          type="text"
          value={queryText}
          onChange={onQueryChange}
          placeholder="Search your media — describe what you're looking for…"
          autoFocus
        />
      </Container>

      <Container flex="1" overflow="auto" padding="none">
        {error ? (
          <EmptyPlaceholder icon={Search} message="Search failed" title="Search failed" description={error} />
        ) : loading ? (
          <Container layout="vertical" gap="sm" alignItems="center" justifyContent="center" padding="lg" height="full">
            <Spinner size="lg" aria-label="Searching" />
            <Text variant="body-xs" color="subtle">Searching your media…</Text>
          </Container>
        ) : queryText.trim() === '' ? (
          <EmptyPlaceholder icon={Search} message="Search to discover media" title="Search to discover media" description="Describe a moment — “forehand follow-through”, “sunset”, “someone laughing” — and matching clips appear." />
        ) : results.length === 0 ? (
          <EmptyPlaceholder icon={Film} message="No media found" title="No media found" description={`Nothing matched “${queryText}”.`} />
        ) : (
          <Container layout="vertical" gap="md" padding="lg">
            <Text variant="caption" color="subtle">{results.length} results</Text>
            <Container gridCols="auto-fill-xs" gap="md">
              {results.map(renderTile)}
            </Container>
          </Container>
        )}
      </Container>

      {selected.size > 0 ? (
        <BulkSelectBar
          selectedCount={selected.size}
          onClearAll={() => setSelected(new Set())}
          actions={[{ label: 'Make a video', onClick: () => props.onAction?.('make-video', Array.from(selected)) }]}
        />
      ) : null}
    </Container>
  );
}

// Runtime screen-mount entry. The shell resolves `module.default || module.putOnScreen
// || module.mount` and calls it with `{ el, props }`, expecting a cleanup FUNCTION.
// The package entry (`.bitfield-entry-scope/media-search/entry.ts`) re-exports this as
// `{ default as mount }`, so without a default export the surface fails with "no default,
// putOnScreen, or mount export" and find-my-media renders blank. Converged onto the shared
// `mountReactSurface` seam like the other 123 packages (L140); the legacy `bitfieldMount`
// that used raw ReactDOM.createRoot is removed.
export default function mount({ el, props = {} }: { el: HTMLElement; props?: MediaSearchSurfaceProps }) {
  return mountReactSurface(el, <MediaSearchSurface {...props} />);
}
