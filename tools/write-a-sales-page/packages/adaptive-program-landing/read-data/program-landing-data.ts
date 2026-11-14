export type ProgramCopySegment = {
  readonly text: string;
  readonly tone?: 'blue' | 'green' | 'orange' | 'purple' | 'red' | 'rainbow';
  readonly solid?: boolean;
};

export type ProgramSectionCopy = {
  readonly bridge?: readonly ProgramCopySegment[];
  readonly headline: readonly ProgramCopySegment[];
  readonly lines?: readonly string[];
  readonly getLine?: string | readonly ProgramCopySegment[];
  readonly visual:
    | 'hero-slot'
    | 'comparison-library'
    | 'guided-media'
    | 'strategy-sequence'
    | 'observed-dialogue'
    | 'composure-readout'
    | 'adaptive-priority'
    | 'recalculate'
    | 'none';
};

export type ProgramTestimonial = {
  readonly quote: string;
  readonly name: string;
  readonly role?: string;
  readonly accent?: string;
};

/** One row of the page's order. `block` names which renderer runs; every other
 *  field is that block's own DATA. Repeating a block is repeating a row. */
export type ProgramPageBlockRow = Record<string, unknown> & { readonly block: string };

/** The page's one call to action, in one place, so every repetition of it says
 *  the same thing and changing it changes all of them. */
export type ProgramCta = {
  readonly href: string;
  readonly label: string;
  readonly note?: string;
};

export type ProgramLandingData = {
  readonly cta: ProgramCta;
  readonly pageBlocks: readonly ProgramPageBlockRow[];
  readonly schema: 'adaptive-program-landing.data/v2';
  readonly brand: Record<string, any>;
  readonly routes: Record<string, string>;
  readonly heroLead: readonly ProgramCopySegment[];
  readonly faqIntro: string;
  readonly config: Record<string, any>;
  readonly sections: readonly ProgramSectionCopy[];
  readonly recalculate: Record<string, any>;
  readonly testimonials: readonly ProgramTestimonial[];
  readonly marqueeTestimonials: readonly ProgramTestimonial[];
  readonly faq: readonly { q: string; answer: string }[];
  readonly guidedMedia: Record<string, any>;
  readonly strategySequence: Record<string, any>;
  readonly comparisonLibrary: Record<string, any>;
  readonly presentation: Record<string, any>;
  readonly pricing: Record<string, any>;
  readonly systemVisuals: Record<string, any>;
  readonly demoScenario: Record<string, any>;
  readonly comparisons: readonly Record<string, any>[];
  readonly libraryNames: readonly string[];
  readonly libraryPreviews: readonly Record<string, any>[];
  readonly community: Record<string, any>;
  readonly proofDefaults: Record<string, any>;
};

export function assertProgramLandingData(value: unknown): asserts value is ProgramLandingData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('program landing DATA must be an object');
  const data = value as Record<string, unknown>;
  if (data.schema !== 'adaptive-program-landing.data/v2') throw new Error('program landing DATA schema is not recognized');
  for (const key of ['brand', 'routes', 'config', 'recalculate', 'pricing', 'systemVisuals', 'demoScenario', 'community', 'guidedMedia', 'strategySequence', 'comparisonLibrary', 'presentation']) {
    if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) throw new Error(`program landing DATA is missing ${key}`);
  }
  for (const key of ['heroLead', 'sections', 'testimonials', 'marqueeTestimonials', 'faq', 'comparisons', 'libraryNames', 'libraryPreviews', 'pageBlocks']) {
    if (!Array.isArray(data[key])) throw new Error(`program landing DATA is missing ${key}`);
  }

  // A page with no order is a blank page, and a block row that names nothing is
  // a silently skipped section. Both fail here rather than at a visitor.
  const pageBlocks = data.pageBlocks as unknown[];
  if (pageBlocks.length === 0) throw new Error('program landing DATA is missing pageBlocks rows');
  pageBlocks.forEach((row, index) => {
    const named = row && typeof row === 'object' && typeof (row as Record<string, unknown>).block === 'string' && (row as Record<string, unknown>).block !== '';
    if (!named) throw new Error(`program landing DATA pageBlocks[${index}] is missing block`);
  });

  // Every weave a marquee block declares must name a real source array, or the
  // row moves with nothing in it and reads as a broken section.
  pageBlocks.forEach((row, index) => {
    const weave = (row as Record<string, unknown>).weave as Record<string, any> | undefined;
    if (!weave) return;
    if (!Array.isArray(weave.pattern) || weave.pattern.length === 0) throw new Error(`program landing DATA pageBlocks[${index}].weave.pattern is missing`);
    for (const name of weave.pattern) {
      const source = weave.sources?.[name];
      if (!source || typeof source.from !== 'string' || !Array.isArray(data[source.from])) {
        throw new Error(`program landing DATA pageBlocks[${index}].weave.sources.${name} does not name a DATA array`);
      }
      if (!source.fields || typeof source.fields !== 'object') {
        throw new Error(`program landing DATA pageBlocks[${index}].weave.sources.${name}.fields is missing`);
      }
    }
  });

  const requiredPaths = [
    ['guidedMedia', 'videoSrc'], ['guidedMedia', 'poster'], ['guidedMedia', 'videoLabel'],
    ['guidedMedia', 'surfaceAriaLabel'], ['guidedMedia', 'liveLabel'], ['guidedMedia', 'successRateLabel'],
    ['guidedMedia', 'learningZoneTemplate'], ['guidedMedia', 'watchingLabel'], ['guidedMedia', 'messagesAriaLabel'],
    ['strategySequence', 'headerLabel'], ['strategySequence', 'instructionTitle'],
    ['strategySequence', 'fieldAriaLabel'], ['strategySequence', 'solvedTemplate'], ['strategySequence', 'pendingText'],
    ['comparisonLibrary', 'comparisonAriaTemplate'], ['comparisonLibrary', 'carouselAriaLabel'],
    ['comparisonLibrary', 'intro'], ['comparisonLibrary', 'selectorAriaLabel'], ['comparisonLibrary', 'browserTitle'],
    ['presentation', 'navigation', 'pricingLabel'], ['presentation', 'navigation', 'accountLabel'],
    ['presentation', 'testimonials', 'marqueeAriaLabel'], ['presentation', 'community', 'headline'],
    ['presentation', 'typography', 'bodyFamily'], ['presentation', 'typography', 'displayFamily'],
    ['cta', 'label'], ['cta', 'href'],
  ] as const;
  for (const path of requiredPaths) {
    let current: unknown = data;
    for (const segment of path) current = current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined;
    if ((typeof current !== 'string' || current.trim() === '') && !Array.isArray(current)) {
      throw new Error(`program landing DATA is missing ${path.join('.')}`);
    }
  }
  const sequence = data.strategySequence as Record<string, unknown>;
  if (!Array.isArray(sequence.shots) || sequence.shots.length === 0) throw new Error('program landing DATA is missing strategySequence.shots');
  const field = sequence.field as Record<string, unknown> | undefined;
  if (!field || !Array.isArray(field.primitives) || field.primitives.length === 0) throw new Error('program landing DATA is missing strategySequence.field.primitives');
  const guidedMedia = data.guidedMedia as Record<string, unknown>;
  if (!Array.isArray(guidedMedia.lines) || guidedMedia.lines.length === 0) throw new Error('program landing DATA is missing guidedMedia.lines');
  const presentation = data.presentation as Record<string, any>;
  if (!Array.isArray(presentation.typography?.faces) || presentation.typography.faces.length === 0) throw new Error('program landing DATA is missing presentation.typography.faces');
}
