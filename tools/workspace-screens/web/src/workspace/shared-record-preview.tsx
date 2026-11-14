// Collection previews reuse the shared MediaPreview's visibility observer and current screen-look.
// The app supplies only routing and admitted saved preview fields; there is no browser video decode fallback.
import React from 'react';
import { MediaPreview, type MediaPreviewProps } from '../../parts/ui/show/media-preview';
import { readJson } from './api';
import { onStoreChange } from './store-changes';
import { sharedRecordPreviewReads } from './shared-record-preview-reads.mjs';
import { familyOf, previewFor } from './file-picture';

type SavedSharedPreview = { file: { name: string | null; title?: string | null; media_type?: string | null }; poster?: string; peaks?: number[]; lines?: string };

const readVisiblePreview = sharedRecordPreviewReads((spacePath: string, itemIds: string[]) =>
  // Explicit GET rechecks the owner without a kept answer or mutation invalidation.
  readJson<{ previews: Record<string, SavedSharedPreview | null> }>(`${spacePath}/previews?item_ids=${encodeURIComponent(JSON.stringify(itemIds))}`, {
    method: 'GET',
  }, true, { applyFocus: false }));

type SharedRecordPreviewProps = {
  spacePath: string; itemId: string; scopeKey: string; fallback: MediaPreviewProps;
};

export function SharedRecordPreview(props: SharedRecordPreviewProps) {
  const scope = JSON.stringify([props.spacePath, props.itemId, props.scopeKey]);
  return <ScopedSharedRecordPreview key={scope} {...props} scope={scope} />;
}

function ScopedSharedRecordPreview({ spacePath, itemId, scope, fallback }: SharedRecordPreviewProps & { scope: string }) {
  const currentScope = React.useRef(scope);
  currentScope.current = scope;
  const [visible, setVisible] = React.useState(false);
  const [saved, setSaved] = React.useState<{ scope: string; preview: SavedSharedPreview } | null>(null);
  React.useEffect(() => {
    if (!visible) return;
    let active = true;
    let generation = 0;
    const read = async () => {
      const request = ++generation;
      setSaved(null);
      const applies = () => active && currentScope.current === scope && request === generation;
      try {
        const result = await readVisiblePreview(spacePath, itemId, applies);
        if (applies()) setSaved(result ? { scope, preview: result } : null);
      } catch { if (applies()) setSaved(null); }
    };
    void read();
    const stop = onStoreChange(read);
    return () => { active = false; stop(); };
  }, [visible, scope, spacePath, itemId]);
  const preview = saved?.scope === scope ? saved.preview : null;
  const look = preview ? previewFor(familyOf(preview.file.name ?? preview.file.title ?? '', preview.file.media_type)) : null;
  const picture = look && preview ? { ...fallback, renderer: look.renderer, icon: look.icon, typeLabel: look.type_label,
    source: preview.poster, peaks: preview.peaks, text: preview.lines } : fallback;
  return <MediaPreview {...picture} onVisibilityChange={setVisible} />;
}
