'use client';

// Generic renderer for one DATA-owned copy beat: a full-viewport bridge with
// solid red engraved emphasis, a solid green engraved statement headline,
// supporting lines, and the section's configured visual in its slot. ONE
// renderer over the copy DATA array; adding a section is one row (L069/L090).

import React from 'react';
import { SectionShell, TextColumn } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { Text } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { StatementText } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { GuidedMediaSection } from './GuidedMediaSection';
import { StrategySequenceSection } from './StrategySequenceSection';
import { AdaptivePriorityVisual, ComposureReadoutVisual, ObservedDialogueVisual } from './ProgramSystemVisuals';
import { ComparisonLibrarySection } from './ComparisonLibrarySection';
import {
  PROGRAM_BRIDGE_SOLID_HIGHLIGHT_COLOR,
  PROGRAM_HERO_ENGRAVED_HEADING_STYLE,
} from './programHeroTypography';
import { highlightInkColor } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { LANDING_SOLID_HIGHLIGHT_COLOR } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import type { ProgramCopySegment, ProgramSectionCopy } from '../read-data/program-landing-data';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ProgramStatementSection.module.css';

// A getLine can be a plain string or data-owned emphasis segments. When it is
// segments, a `tone`/`solid` phrase renders in its highlight color (L090) so a
// supporting paragraph can carry one colored key phrase instead of flat text.
function renderGetLine(getLine: string | readonly ProgramCopySegment[]) {
  if (typeof getLine === 'string') return getLine;
  return getLine.map((seg, i) => {
    if (seg.tone) return <span key={i} style={{ color: highlightInkColor(seg.tone), fontWeight: 800 }}>{seg.text}</span>;
    if (seg.solid) return <span key={i} style={{ color: LANDING_SOLID_HIGHLIGHT_COLOR, fontWeight: 800 }}>{seg.text}</span>;
    return <React.Fragment key={i}>{seg.text}</React.Fragment>;
  });
}

function VisualFor({ kind }: { kind: ProgramSectionCopy['visual'] }) {
  switch (kind) {
    case 'comparison-library': return <ComparisonLibrarySection />;
    case 'guided-media': return <GuidedMediaSection />;
    case 'strategy-sequence': return <StrategySequenceSection />;
    case 'observed-dialogue': return <ObservedDialogueVisual />;
    case 'composure-readout': return <ComposureReadoutVisual />;
    case 'adaptive-priority': return <AdaptivePriorityVisual />;
    default: return null;
  }
}

export function ProgramBridgeMoment({ bridge, id }: { bridge: readonly ProgramCopySegment[]; id?: string }) {
  // Bridge emphasis is DATA-driven (L090): a segment with an explicit `tone`
  // renders in that engraved color (e.g. green for a positive-capability
  // payoff line), while a bare `solid` segment keeps the default red engraved
  // tension color used by the "But ..." pivot bridges. Red means a problem,
  // green means a capability you now have; the color carries meaning.
  const redHighlightLine = bridge.map((segment) => ({
    text: segment.text,
    ...(segment.tone
      ? { tone: segment.tone }
      : segment.solid
        ? {
            solid: true,
            solidColor: PROGRAM_BRIDGE_SOLID_HIGHLIGHT_COLOR,
          }
        : {}),
  }));

  return (
    <section
      aria-label="Section bridge"
      className={styles.bridgeMoment}
      data-bridge-moment={id ?? 'section'}
      data-testid="program-bridge-moment"
    >
      <div className={styles.bridgeInner}>
        <StatementText
          align="center"
          className="program-heading"
          lines={[redHighlightLine]}
          size="section"
          style={PROGRAM_HERO_ENGRAVED_HEADING_STYLE}
          tracePrefix={`program-bridge-${id ?? 'section'}`}
        />
      </div>
    </section>
  );
}

export function ProgramStatementSection({ copy }: { copy: ProgramSectionCopy }) {
  return (
    <>
      {copy.bridge ? <ProgramBridgeMoment bridge={copy.bridge} id={copy.visual} /> : null}
      <SectionShell size="wide" paddingY="default">
        <TextColumn measure="hero" align="center" className="gap-3">
          {copy.getLine ? (
            <Text
              as="p"
              className={styles.getLine}
              data-testid={`program-get-line-${copy.visual}`}
              variant="body"
              color="default"
              style={{
                fontSize: 'clamp(1.28rem, 1.8vw + 0.62rem, 1.72rem)',
                lineHeight: 1.38,
                maxWidth: 760,
                fontWeight: 760,
                letterSpacing: '-0.018em',
                marginBottom: 'clamp(36px, 5vw, 54px)',
              }}
            >
              {renderGetLine(copy.getLine)}
            </Text>
          ) : null}
          <StatementText
            lines={[copy.headline]}
            size="section"
            align="center"
            className="program-heading"
            style={PROGRAM_HERO_ENGRAVED_HEADING_STYLE}
          />
          {copy.lines?.map((line, i) => (
            <Text
              as="p"
              key={i}
              variant="body"
              color={i === copy.lines!.length - 1 ? 'default' : 'muted'}
              style={{
                fontSize: 'clamp(1rem, 1.4vw + 0.55rem, 1.25rem)',
                lineHeight: 1.55,
                maxWidth: 680,
                fontWeight: i === copy.lines!.length - 1 ? 600 : 400,
                marginTop: i === 0 ? 'clamp(22px, 3vw, 34px)' : undefined,
              }}
            >
              {line}
            </Text>
          ))}
        </TextColumn>
        <VisualFor kind={copy.visual} />
      </SectionShell>
    </>
  );
}
