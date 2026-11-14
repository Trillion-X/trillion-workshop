'use client';

// Generic adaptive-program landing composition. Product identity, words, routes,
// media, demonstrations, prices, and proof all arrive through package-set DATA.

import React from 'react';
import { PageShell, SectionShell, TextColumn } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { Container } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { StatementText, StatementHighlight } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { SectionDivider } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { FaqSection } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { SiteHeader } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { LandingMinimap } from '@/packages/ui/show/marketing-page/LandingMinimap';
import { EngravedTextDefs } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { LANDING_SOLID_HIGHLIGHT_COLOR } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { LANDING_FILM_GRAIN_TEXTURE, LANDING_LAYER_Z_INDEX } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { ProgramBridgeMoment, ProgramStatementSection } from './ProgramStatementSection';
import { ProgramPricingSection } from './ProgramPricingSection';
import { RecalculateVisual } from './ProgramSystemVisuals';
import { CtaBlock } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import { ProgramProofMarquee } from './ProgramProofMarquee';
import { ProgramComparisonShowcase } from './ProgramComparisonShowcase';
import { ComparisonLibrarySection } from './ComparisonLibrarySection';
import { ProgramNamedStrip } from './ProgramNamedStrip';
import { ProgramQuoteSpotlight } from './ProgramQuoteSpotlight';
import { ProgramResultsGrid } from './ProgramResultsGrid';
import { ProgramStoryBlock } from './ProgramStoryBlock';
import { ProgramCommunitySection } from './ProgramCommunitySection';
import { ProgramArticlesSection } from './ProgramArticlesSection';
import { ProgramEmailCourseSection } from './ProgramEmailCourseSection';
import { PROGRAM_HERO_ENGRAVED_HEADING_STYLE } from './programHeroTypography';
import { ProgramLandingDataProvider, useProgramLandingData } from './ProgramLandingData';
import type { ProgramLandingData, ProgramTestimonial } from '../read-data/program-landing-data';
import type { ProofWeaveDescriptor } from '../read-data/weave-proof-items';
import surfaceStyles from '@/packages/screen-look/show/adaptive-program-landing/ProgramLandingSurface.module.css';
// The canvas, its film grain and the viewport fade come from the one shared
// owner, the same material the Trillion landing wears. This page used to carry
// its own single-layer grain at 16% multiply, which read as no grain at all.
import '@/packages/screen-look/show/styles/landing-canvas-material.css';

// Hero segment renderer, ported from the proven business-landing hero
// segment painter (the landing flow visual): `solid` paints the crisp solid
// highlight color, `tone` the watercolor gradient. Byte-same treatment (L193).
function renderHeroSegment(seg: { text: string; tone?: string; solid?: boolean }, i: number) {
  if (seg.solid) return <span key={i} style={{ color: LANDING_SOLID_HIGHLIGHT_COLOR }}>{seg.text}</span>;
  if (seg.tone) return <StatementHighlight key={i} tone={seg.tone as never}>{seg.text}</StatementHighlight>;
  return <React.Fragment key={i}>{seg.text}</React.Fragment>;
}

const roleFor = (name: string, labels: Record<string, any>) => labels.roleRules.find((rule: Record<string, string>) => name.toLowerCase().includes(rule.contains.toLowerCase()))?.role ?? labels.defaultRole;
const spotlightFor = (t: ProgramTestimonial, labels: Record<string, any>) => {
  return { quote: t.quote, name: t.name.replace(/\s*\(.*\)$/, ''), role: t.role ?? roleFor(t.name, labels) };
};
const gridCardsFor = (items: readonly ProgramTestimonial[], labels: Record<string, any>) => items.map((t) => ({
  quote: t.quote,
  name: t.name,
  role: t.role ?? labels.gridRole,
}));
const PROGRAM_SECTION_TESTIMONIAL_DESIGNS = [
  ProgramResultsGrid,
  ProgramQuoteSpotlight,
  ProgramStoryBlock,
  ProgramNamedStrip,
] as const;

function ProgramCanvasTexture() {
  return (
    <div
      aria-hidden="true"
      className="landing-canvas-texture"
      style={{
        '--landing-page-grain': LANDING_FILM_GRAIN_TEXTURE,
        '--landing-canvas-texture-z-index': String(LANDING_LAYER_Z_INDEX.pageTexture),
      } as React.CSSProperties}
    />
  );
}

function ProgramTypography({ typography }: { typography: Record<string, any> }) {
  const faces = typography.faces.map((face: Record<string, any>) => `@font-face{font-family:${JSON.stringify(face.family)};src:url(${JSON.stringify(face.src)}) format(${JSON.stringify(face.format)});font-weight:${face.weight};font-style:${face.style ?? 'normal'};font-display:swap;}`).join('');
  return <style>{faces}</style>;
}

function ProgramHero() {
  const data = useProgramLandingData();
  const studioHero = data.config.studioHero;
  return (
    // The hero closes tight against whatever DATA puts under it. It used to
    // hold the testimonial rail, so its generous bottom padding sat between the
    // promise and the proof; with that rail moved to its own block the padding
    // became a field of white between the subheader and the call to action,
    // which is the one place on this page a reader must not have to hunt.
    <Container id="overview" style={{ padding: '96px 0 0', scrollMarginTop: 96, width: '100%' }}>
      <SectionShell className={surfaceStyles.heroShell} size="wide" paddingY="compact" style={{ paddingBottom: 0 }}>
        {/* The page's real h1: the hero promise with its solid-green segment,
            engraved exactly like the reference founder landing. */}
        <div style={{ maxWidth: 1000, margin: '0 auto', textAlign: 'center', padding: '0 8px' }}>
          <h1 className="program-heading" style={{ ...PROGRAM_HERO_ENGRAVED_HEADING_STYLE, margin: 0 }}>
            {studioHero.heroHeadline.map((seg, i) => renderHeroSegment(seg, i))}
          </h1>
          <p style={{ fontSize: 'clamp(1.12rem, 1.35vw + 0.78rem, 1.55rem)', fontWeight: 500, lineHeight: 1.45, color: 'rgba(15,23,42,0.74)', margin: '18px auto 0', maxWidth: 820 }}>
            {studioHero.heroSubheader.map((seg, i) => renderHeroSegment(seg, i))}
          </p>
        </div>
      </SectionShell>
    </Container>
  );
}

// The page's lead statement. It used to sit inside the hero, above the fold,
// between the promise and everything else; it is a block now so DATA decides
// where a reader meets it rather than the hero owning it by position.
function ProgramHeroLead() {
  const data = useProgramLandingData();
  return (
    <SectionShell size="wide" paddingY="compact">
      <StatementText
        lines={[data.heroLead]}
        size="section"
        align="center"
        className="program-heading"
        style={PROGRAM_HERO_ENGRAVED_HEADING_STYLE}
      />
    </SectionShell>
  );
}

// One call to action, repeated. The label, destination and note come from the
// page's single `cta` DATA object, so eight placements never drift into eight
// different buttons; a block row may still override any of the three when a
// particular placement genuinely needs its own words.
function ProgramCtaBlock({ block }: { block: ProgramPageBlock }) {
  const { cta } = useProgramLandingData();
  return (
    <CtaBlock
      href={(block.href as string) ?? cta.href}
      id={block.id as string | undefined}
      label={(block.label as string) ?? cta.label}
      note={(block.note as string) ?? cta.note}
    />
  );
}

function ProgramRecalculateSection() {
  const { recalculate } = useProgramLandingData();
  return (
    <>
      <ProgramBridgeMoment bridge={recalculate.bridge} id="recalculate" />
      <SectionShell size="wide" paddingY="default">
        <TextColumn measure="hero" align="center" className="gap-3">
          <p
            data-testid="program-get-line-recalculate"
            style={{ color: '#0f172a', fontSize: 'clamp(1.28rem, 1.8vw + 0.62rem, 1.72rem)', fontWeight: 760, letterSpacing: '-0.018em', lineHeight: 1.38, margin: '0 0 8px', maxWidth: 760 }}
          >
            {recalculate.getLine}
          </p>
          <StatementText
            lines={[recalculate.headline]}
            size="section"
            align="center"
            className="program-heading"
            style={PROGRAM_HERO_ENGRAVED_HEADING_STYLE}
          />
        </TextColumn>
        <RecalculateVisual />
      </SectionShell>
    </>
  );
}

function ProgramFooter() {
  const { brand, recalculate } = useProgramLandingData();
  return (
    <SectionShell size="wide" className="justify-center gap-6 pb-0 md:pb-0" paddingY="default">
      <TextColumn measure="hero" align="center" className="gap-3">
        {/* The canonical closing question appears once, after pricing, testimonials, and FAQ. */}
        <StatementText
          lines={[recalculate.closingQuestion]}
          size="footer"
          align="center"
          className="program-heading"
          style={PROGRAM_HERO_ENGRAVED_HEADING_STYLE}
        />
      </TextColumn>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '26px 0 18px' }}>
        <span style={{ fontWeight: 700, fontSize: '1.1rem', color: '#0f172a' }}>
          {brand.shortName} <span style={{ fontWeight: 500, color: 'rgba(15,23,42,0.5)' }}>{brand.descriptor}</span>
        </span>
      </div>
    </SectionShell>
  );
}

function ProgramFaqSection() {
  const data = useProgramLandingData();
  return <FaqSection intro={data.faqIntro} items={data.faq} />;
}

// The narrative run: every copy beat, each followed by proof in a different
// shape so no two sections argue the same way, and — when DATA asks for it —
// the same call to action at the end of each, because a reader who is
// convinced at beat three should not have to scroll to beat seven to act.
function ProgramStorySections({ block }: { block: ProgramPageBlock }) {
  const data = useProgramLandingData();
  const proofQuotes = data.marqueeTestimonials.slice(8);
  const testimonialLabels = data.presentation.testimonials;
  let proofCursor = 0;
  const testimonialSlots = data.sections.map((_, index) => {
    const design = index % PROGRAM_SECTION_TESTIMONIAL_DESIGNS.length;
    const count = design === 0 ? 3 : design === 3 ? 9 : 1;
    const selected = proofQuotes.slice(proofCursor, proofCursor + count);
    proofCursor += count;
    if (design === 0) return <ProgramResultsGrid cards={gridCardsFor(selected, testimonialLabels)} />;
    if (design === 1) return <ProgramQuoteSpotlight testimonial={spotlightFor(selected[0], testimonialLabels)} />;
    if (design === 2) return <ProgramStoryBlock story={{ outcome: testimonialLabels.storyOutcome, ...spotlightFor(selected[0], testimonialLabels) }} />;
    return <ProgramNamedStrip quotes={selected} />;
  });
  const closeEverySection = block.ctaAfterEachSection !== false;
  return (
    <>
      {data.sections.map((copy, index) => (
        <Container id={`program-${copy.visual}`} key={index} style={{ scrollMarginTop: 96 }}>
          <ProgramStatementSection copy={copy} />
          <SectionDivider />
          {testimonialSlots[index]}
          {closeEverySection ? <ProgramCtaBlock block={{ block: 'cta', id: `cta-${copy.visual}` }} /> : null}
          {index < data.sections.length - 1 ? <SectionDivider /> : null}
        </Container>
      ))}
    </>
  );
}

export type ProgramPageBlock = Record<string, unknown> & { readonly block: string };

// The page's order is DATA, not this file's line order.
//
// Every block below is a leaf that knows how to render itself from the page's
// DATA; this map is the only place a block name becomes a rendered thing.
// Moving a section, repeating one (the call to action appears eight times, the
// prices twice), or dropping one is a row in `pageBlocks` and ZERO edits here.
// Adding a genuinely new KIND of block is one entry — never a branch in the
// page body, which is why the body below is four lines long and stays that way.
const PROGRAM_PAGE_BLOCKS: Record<string, (props: { block: ProgramPageBlock }) => React.ReactNode> = {
  community: () => <ProgramCommunitySection />,
  'comparison-showcase': ({ block }) => <ProgramComparisonShowcase instanceId={(block.id as string) ?? 'showcase'} />,
  'comparison-library': () => <SectionShell size="wide" paddingY="default"><ComparisonLibrarySection showComparison={false} /></SectionShell>,
  'article-cards': () => <ProgramArticlesSection />,
  'email-course': () => <ProgramEmailCourseSection />,
  cta: ProgramCtaBlock,
  divider: () => <SectionDivider />,
  faq: () => <ProgramFaqSection />,
  footer: () => <ProgramFooter />,
  hero: () => <ProgramHero />,
  'hero-lead': () => <ProgramHeroLead />,
  pricing: ({ block }) => <ProgramPricingSection instanceId={(block.id as string) ?? undefined} />,
  'proof-marquee': ({ block }) => (
    <ProgramProofMarquee
      pixelsPerSecond={block.pixelsPerSecond as number | undefined}
      rows={block.rows as number | undefined}
      weave={block.weave as ProofWeaveDescriptor}
    />
  ),
  recalculate: () => <ProgramRecalculateSection />,
  'story-sections': ProgramStorySections,
};

function ProgramLandingContent() {
  const data = useProgramLandingData();
  const minimapItems = data.presentation.navigation.minimap;
  return (
    <div style={{ '--font-body': data.presentation.typography.bodyFamily, '--font-display': data.presentation.typography.displayFamily } as React.CSSProperties}>
      <ProgramTypography typography={data.presentation.typography} />
      <PageShell className={surfaceStyles.root}>
      <SiteHeader
        accountLink={null}
        brandHref="#overview"
        brandLabel={data.brand.homeLabel}
        brandLogoAlt={data.brand.logoAlt}
        brandLogoSrc={data.brand.logoSrc}
        ctaHref="#pricing"
        ctaText={data.presentation.navigation.pricingLabel}
        menuLinks={[
          ...(data.routes.articles && data.presentation.navigation.articlesLabel ? [{ href: data.routes.articles, label: data.presentation.navigation.articlesLabel }] : []),
          { href: data.routes.pricingAnchor, label: data.presentation.navigation.pricingLabel, detail: data.pricing.menuDetail },
          { href: data.routes.account, label: data.presentation.navigation.accountLabel, detail: data.brand.accountDetail },
        ]}
        navLinks={[
          ...(data.routes.articles && data.presentation.navigation.articlesLabel ? [{ href: data.routes.articles, label: data.presentation.navigation.articlesLabel }] : []),
          { href: data.routes.account, label: data.presentation.navigation.accountLabel },
        ]}
        showThemePicker={false}
      />
      <LandingMinimap items={minimapItems} />
      <ProgramCanvasTexture />
      <Container className="landing-page program-landing-scroll">
        <EngravedTextDefs />
        {data.pageBlocks.map((block, index) => {
          const Block = PROGRAM_PAGE_BLOCKS[block.block];
          return Block ? <React.Fragment key={`${block.block}-${index}`}>{Block({ block })}</React.Fragment> : null;
        })}
      </Container>
      </PageShell>
    </div>
  );
}

export function ProgramLanding({ data }: { data: ProgramLandingData }) {
  return <ProgramLandingDataProvider data={data}><ProgramLandingContent /></ProgramLandingDataProvider>;
}
