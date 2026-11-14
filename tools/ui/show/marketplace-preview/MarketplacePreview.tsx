// NO PRIOR: searched 'marketplace preview', 'item detail preview', 'arrangement thumbnail' and 'look preview' in bitfield-packages/packages/*/show; searched 21st.dev for 'marketplace item preview detail dialog with add install action' (Dialog 378 and Recipe Card 22103 did not fit this existing listing flow). Mobbin MCP is not available in this session; the Marketplace screen already cites its live card references.
import React, { useEffect, useState } from 'react';
import { Button, Container, Text } from '../../index';
import { ImageBlock } from '../image-block/ImageBlock';
import { ArrangementThumbnail, type ArrangementThumbnailBox } from '../arrangement-thumbnail';

export type MarketplacePreviewItem = {
  id: string;
  title: string;
  kind_label: string;
  job: string;
  picture?: string;
  facts: { label: string; value: string; icon?: string }[];
  preview?: { type: string; arrangement?: unknown; colours?: Record<string, unknown>; screen_labels?: Record<string, { label?: string; icon?: string }> };
  use_verb?: string;
  can: string[];
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

/** Turns the actual arrangement tree into the same boxes used by the Layouts picker. */
export function marketplaceArrangementBoxes(
  input: unknown,
  labels: Record<string, { label?: string; icon?: string }> = {},
): ArrangementThumbnailBox[] {
  const out: ArrangementThumbnailBox[] = [];
  let index = 0;
  const visit = (value: unknown, x: number, y: number, w: number, h: number) => {
    if (!object(value)) return;
    if (value.kind === 'pane') {
      const surfaces = Array.isArray(value.surfaces) ? value.surfaces : [];
      const selectedId = text(value.show);
      const selected = surfaces.find(surface => (typeof surface === 'string' ? surface : object(surface) ? text(surface.id) : '') === selectedId) ?? surfaces[0];
      const thing = typeof selected === 'string' ? { id: selected } : object(selected) ? selected : {};
      const id = text(thing.id);
      if (id) {
        const known = labels[id];
        const label = text(thing.title) || text(known?.label);
        out.push({ id: `pane-${index++}`, x, y, w, h, ...(text(known?.icon) ? { icon: text(known?.icon) } : {}), ...(label ? { label } : {}) });
      }
      return;
    }
    if (value.kind !== 'split' || !Array.isArray(value.children) || !value.children.length || !['row', 'column'].includes(String(value.dir))) return;
    const children = value.children;
    const validSizes = Array.isArray(value.sizes) && value.sizes.length === children.length
      && value.sizes.every(size => typeof size === 'number' && Number.isFinite(size) && size > 0);
    const sizes = validSizes ? value.sizes as number[] : children.map(() => 1);
    const total = sizes.reduce((sum, size) => sum + size, 0);
    let offset = 0;
    children.forEach((child, childIndex) => {
      const share = sizes[childIndex] / total;
      if (value.dir === 'row') visit(child, x + offset * w, y, share * w, h);
      else visit(child, x, y + offset * h, w, share * h);
      offset += share;
    });
  };
  visit(input, 0, 0, 1, 1);
  return out;
}

function paletteColours(item: MarketplacePreviewItem): { label: string; value: string }[] {
  const colours = item.preview?.colours;
  if (!object(colours)) return [];
  return Object.entries(colours).flatMap(([label, raw]) => {
    const value = text(raw);
    if (!value || !/^(?:#[\da-f]{3,8}|(?:rgb|hsl|oklch)a?\([\d\s.,%/+-]+\))$/i.test(value)) return [];
    return [{ label, value }];
  });
}

export function MarketplacePreview({
  item,
  actionLabel,
  onAction,
  onBack,
}: {
  item: MarketplacePreviewItem;
  actionLabel?: string;
  onAction?: () => void;
  onBack: () => void;
}) {
  const colours = item.preview?.type === 'look' ? paletteColours(item) : [];
  const boxes = item.preview?.type === 'layout' ? marketplaceArrangementBoxes(item.preview.arrangement, item.preview.screen_labels) : [];
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [item.picture]);
  return (
    <Container layout="vertical" gap="sm" padding="md" border="bottom" className="marketplace-preview" aria-label={`${item.kind_label} preview`}>
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="sm">
        <Text variant="heading-sm">{item.title}</Text>
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>Back to Marketplace</Button>
      </Container>
      <Text variant="label" color="secondary">{item.kind_label}</Text>
      {item.job ? <Text variant="body-sm">{item.job}</Text> : null}
      {item.preview?.type === 'screen' && item.picture && !imageFailed ? (
        <ImageBlock src={item.picture} alt={`Screen reference: ${item.title}`} width="full" objectFit="contain" maxHeight="38rem" onError={() => setImageFailed(true)} />
      ) : null}
      {item.preview?.type === 'screen' && !item.picture ? <Text variant="body-sm" color="secondary">No screen image was provided.</Text> : null}
      {item.preview?.type === 'screen' && imageFailed ? <Text variant="body-sm" color="secondary">The screen image could not be loaded.</Text> : null}
      {item.preview?.type === 'look' && colours.length ? (
        <Container layout="horizontal" gap="sm" wrap aria-label="Look colours">
          {colours.map(colour => (
            <Container key={colour.label} layout="vertical" gap="xs" aria-label={`${colour.label}: ${colour.value}`}>
              <span className="block h-12 w-16 rounded-md border border-[var(--border-primary)]" style={{ backgroundColor: colour.value }} />
              <Text variant="body-xs">{colour.label}</Text>
            </Container>
          ))}
        </Container>
      ) : null}
      {item.preview?.type === 'look' && !colours.length ? <Text variant="body-sm" color="secondary">No usable colour values were provided.</Text> : null}
      {item.preview?.type === 'layout' && boxes.length ? (
        <ArrangementThumbnail name={item.title} boxes={boxes} disabled pressLabel={`Preview of ${item.title}`} onPress={() => {}} />
      ) : null}
      {item.preview?.type === 'layout' && !boxes.length ? <Text variant="body-sm" color="secondary">This layout has no previewable panes.</Text> : null}
      {item.facts.length ? (
        <Container layout="vertical" gap="xs" aria-label="Details">
          {item.facts.map(fact => <Text key={`${fact.label}:${fact.value}`} variant="body-sm">{`${fact.label}: ${fact.value}`}</Text>)}
        </Container>
      ) : null}
      {actionLabel && onAction ? <Button type="button" variant="primary" size="sm" onClick={onAction}>{actionLabel}</Button> : null}
    </Container>
  );
}
