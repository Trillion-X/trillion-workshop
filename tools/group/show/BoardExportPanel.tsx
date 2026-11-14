// packages/group/show/BoardExportPanel.tsx
//
// The board EXPORT surface — blind over BOTH the document-export registry AND the
// output-destination registry (L069/L090). Shows format selector + destination choice +
// serialized document. Destinations are envelope-addressed capabilities (clipboard, download,
// selectable-text fallback); adding a new destination is one DATA row + one deliver function,
// zero panel edits. Document formats are registry rows, same as before.

import * as React from 'react';
import { Button, Card, Container, Spinner, Text } from '../../ui';
import type { BoardItem } from '../read-data/group-board-model';
import type { GroupGraph, AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { OutputDestination } from '../../ui/show/output-destination';
import { DOCUMENT_EXPORTS, exportFilename } from '../do-work/board-document-exports';

/**
 * An IMAGE (binary) export the panel can offer alongside the text formats (R43c). Text
 * formats are pure `items -> string` leaves (DOCUMENT_EXPORTS); an image export needs the
 * board's live fill/shape/appearance resolvers, so the OWNER injects it as a capability
 * (same DI as `destinations`): `produce()` renders the artifact (SVG text or PNG bytes)
 * with a filename + mime, and the panel delivers it through the SAME destination chain —
 * so an image saves through the working engine file-save, not the presenter-dead anchor.
 * A new image format is one injected row; the panel stays blind (L069/L090).
 */
export interface ImageArtifactExport {
  readonly id: string;
  readonly label: string;
  readonly produce: () => Promise<{ readonly filename: string; readonly mimeType: string; readonly text?: string; readonly bytes?: Uint8Array }>;
}

export interface BoardExportPanelProps {
  readonly items: readonly BoardItem[];
  readonly now: number;
  readonly title?: string;
  /**
   * The board's live tree (graph + the exported level). Passed so hierarchy-aware formats (Markdown) walk
   * each level in its own space and keep section-nested cards under their heading. Absent -> flat `items`.
   */
  readonly tree?: { readonly graph: GroupGraph; readonly rootRef: AddressRef };
  /** Output destinations (clipboard, download, selectable-text, etc.). Envelope-addressed; caller supplies. */
  readonly destinations: readonly OutputDestination[];
  /** Image (binary) exports offered alongside the text formats (R43c). Owner-injected; empty/absent → none. */
  readonly imageExports?: readonly ImageArtifactExport[];
  /** Transient confirmation toast (R43b) — the SAME notice the image/deck exports fire,
   *  so text export gives the identical "Saved to X" / "Export failed" feedback instead of
   *  only flipping a button label. Absent → silent (the panel still works). */
  readonly onNotice?: (text: string, tone: 'success' | 'error' | 'info') => void;
  readonly onClose: () => void;
}

import { outputDeliveryOutcome, type OutputDeliveryOutcome } from '../../ui/show/output-destination';

export function BoardExportPanel({ items, now, title, tree, destinations, imageExports, onNotice, onClose }: BoardExportPanelProps): JSX.Element {
  const [formatKey, setFormatKey] = React.useState(DOCUMENT_EXPORTS[0]?.key ?? '');
  const [deliveryState, setDeliveryState] = React.useState<'idle' | 'delivering' | OutputDeliveryOutcome>('idle');
  const finishDelivery = (outcome: OutputDeliveryOutcome, label: string) => {
    setDeliveryState(outcome);
    const messages = { delivered: `Exported as ${label}`, requested: 'Download requested', shown: 'Text shown for copying', cancelled: 'Export cancelled', failed: 'Could not export' };
    onNotice?.(messages[outcome], outcome === 'delivered' ? 'success' : outcome === 'failed' ? 'error' : 'info');
  };

  const format = DOCUMENT_EXPORTS.find((e) => e.key === formatKey) ?? DOCUMENT_EXPORTS[0];
  const doc = format ? format.serialize(items, now, { title, tree }) : '';

  /**
   * Attempt delivery through the destination chain: try each in order, stop at first success.
   * Fail-closed: only claims success if a destination actually delivered.
   */
  const deliver = async (destinationId: string) => {
    const destination = destinations.find((d) => d.id === destinationId);
    if (!destination || !format) {
      setDeliveryState('failed');
      return;
    }

    setDeliveryState('delivering');
    try {
      const mimeType = format.mime || 'text/plain';
      const result = await destination.deliver({
        filename: exportFilename(title, format.ext),
        mimeType,
        text: doc,
      });
      finishDelivery(outputDeliveryOutcome(result), format.label);
    } catch {
      setDeliveryState('failed');
      onNotice?.('Could not export', 'error');
    }
  };

  /**
   * Deliver to the first successful destination in the chain (clipboard → download → fallback).
   */
  const deliverAuto = async () => {
    if (!format) return;
    setDeliveryState('delivering');
    try {
      let outcome: OutputDeliveryOutcome = 'failed';
      for (const dest of destinations) {
        const result = await dest.deliver({
          filename: exportFilename(title, format.ext),
          mimeType: format.mime || 'text/plain',
          text: doc,
        });
        outcome = outputDeliveryOutcome(result);
        if (outcome !== 'failed') break;
      }
      finishDelivery(outcome, format.label);
    } catch {
      setDeliveryState('failed');
      onNotice?.('Could not export', 'error');
    }
  };

  /**
   * R43c: render an IMAGE artifact (SVG/PNG) via the owner's `produce`, then deliver it
   * through the SAME destination chain (first success wins). Because the engine file-save
   * destination now forwards bytes, a PNG saves through the working presenter egress — the
   * browser anchor path was dead there.
   */
  const deliverImage = async (image: ImageArtifactExport) => {
    setDeliveryState('delivering');
    try {
      const artifact = await image.produce();
      let outcome: OutputDeliveryOutcome = 'failed';
      for (const dest of destinations) {
        const result = await dest.deliver(artifact);
        outcome = outputDeliveryOutcome(result);
        if (outcome !== 'failed') break;
      }
      finishDelivery(outcome, image.label);
    } catch {
      setDeliveryState('failed');
      onNotice?.('Could not export', 'error');
    }
  };

  return (
    <Card variant="popover" padding="md">
      <Container layout="vertical" gap="sm" style={{ width: 400, maxWidth: 'calc(100vw - 64px)', maxHeight: '70vh', overflowY: 'auto' }}>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-md" weight="semibold">Export</Text>
          <Button
            variant="secondary"
            size="sm"
            disabled={deliveryState === 'delivering'}
            onClick={() => deliverAuto()}
            aria-label={`Deliver the board as ${format?.label ?? ''}`}
          >
            {{ idle: 'Deliver', delivering: 'Delivering…', delivered: 'Delivered', requested: 'Download requested', shown: 'Text shown', cancelled: 'Cancelled', failed: 'Failed' }[deliveryState]}
          </Button>
          {/* R43b: a live busy indicator while the export is in flight — the report was
              "it took a second and there was no indicator/progress". */}
          {deliveryState === 'delivering' ? <Spinner size="sm" /> : null}
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close export">Close</Button>
        </Container>

        {/* Destination choice: ONE button per VISIBLE destination — the set is open DATA
            (L090). Fallback-only rows (a browser anchor dead in the presenter) are hidden
            here (R43a: no "Downloads" AND "Download file" duplicate) but still run in the
            auto chain above. The set stays open: a new visible destination is one DATA row. */}
        <Container layout="horizontal" gap="xs" alignItems="center" style={{ flexWrap: 'wrap' }}>
          {destinations.filter((d) => !d.fallbackOnly).map((d) => (
            <Button
              key={d.id}
              variant="secondary"
              size="sm"
              disabled={deliveryState === 'delivering'}
              onClick={() => deliver(d.id)}
              title={d.hint}
              aria-label={d.label}
            >
              {d.label}
            </Button>
          ))}
        </Container>

        <Container layout="horizontal" gap="xs" alignItems="center" style={{ flexWrap: 'wrap', maxHeight: 180, overflowY: 'auto', flexShrink: 0 }}>
          {DOCUMENT_EXPORTS.map((e) => (
            <Button
              key={e.key}
              variant={e.key === formatKey ? 'primary' : 'ghost'}
              size="sm"
              disabled={deliveryState === 'delivering'}
              onClick={() => {
                setFormatKey(e.key);
                setDeliveryState('idle'); // a new format = reset feedback
              }}
              aria-label={`Export as ${e.label}`}
              aria-pressed={e.key === formatKey}
              style={{ flexShrink: 0 }}
            >
              {e.label}
            </Button>
          ))}
        </Container>

        {/* R43c: IMAGE exports — the board as a picture (SVG / PNG), not only text. Each
            row is an owner-injected `produce` capability; clicking one renders then delivers
            it through the destination chain (engine file-save handles the bytes). Absent →
            the whole row is omitted (the panel stays blind, zero enumeration). */}
        {imageExports && imageExports.length > 0 ? (
          <Container layout="horizontal" gap="xs" alignItems="center" style={{ flexWrap: 'wrap' }}>
            <Text variant="caption" tone="muted">Image:</Text>
            {imageExports.map((img) => (
              <Button
                key={img.id}
                variant="secondary"
                size="sm"
                disabled={deliveryState === 'delivering'}
                onClick={() => deliverImage(img)}
                aria-label={`Export as ${img.label}`}
              >
                {img.label}
              </Button>
            ))}
          </Container>
        ) : null}

        <Text
          variant="caption"
          aria-label={`Board exported as ${format?.label ?? ''}`}
          style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono, ui-monospace, monospace)', maxHeight: 340, overflow: 'auto' }}
        >
          {doc}
        </Text>
      </Container>
    </Card>
  );
}
