import React from 'react';
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit';
import {
  buildEngineReadCurrentRequestFromLabels,
  decodeEngineReadCurrentReply,
} from '@bitfield/runtime-kit/protocol';
import { Badge } from '@/packages/ui/show/badge';
import { Button, buttonVariants } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Input } from '@/packages/ui/show/input';
import { Text } from '@/packages/ui/show/text';
import { PointillistPackagePreviewCanvas } from './PointillistPackagePreviewCanvas';
import { PresentationSectionRenderer } from './PresentationSectionRenderer';
import { AICurationPanelComponent } from './AICurationPanelComponent';
import { StoreRatingsReviews } from './StoreRatingsReviews';
import { StatStrip } from '@/packages/ui/show/stat-strip';
import { SearchModeRow, SEARCH_MODES } from './SearchModeRow';
import { Container } from '@/packages/ui/show/container';
import {
  type BrowseHeroSceneConfig,
  type BrowseInstallDestinationOption,
  type BrowseLocalPackageFileRequestDefaults,
  type BrowseSearchSuggestionConfig,
  type BrowseSurfaceConfig,
  type BrowseSurfaceActionConfig,
  type CatalogCardView,
  type CatalogAcquisitionActionView,
  type CatalogCapabilityCompositionView,
  type CatalogInstallActionView,
  type CatalogDiscoveryShelfView,
  type CatalogDiscoveryView,
  type CatalogFilter,
  type CatalogReplacementSearchResult,
  filterCatalogCards,
  searchReplacementCatalog,
  readBrowseSurfaceConfig,
  readCatalogView,
} from '../read-data/read-catalog-view';

type PointillistPreviewCard = CatalogCardView & {
  preview_art: NonNullable<CatalogCardView['preview_art']> & { data_url: string };
};

type AccountSessionView = {
  accountId: string;
};

type HostedPaymentSubmitState = {
  ready: boolean;
  submit: (() => void) | null;
  submitting: boolean;
};

type HostedPaymentMaterial = {
  checkout: Record<string, unknown>;
  checkoutRequest: Record<string, unknown>;
  completeTarget: string;
  customer: Record<string, unknown>;
  materialTarget: string;
  startTarget: string;
};

export function BitfieldPackageStoreBrowseSurface({
  actionCapabilities,
  browseConfig,
  catalog,
  installDestinations,
}: {
  actionCapabilities?: unknown;
  browseConfig?: unknown;
  catalog?: unknown;
  installDestinations?: unknown;
}) {
  const [query, setQuery] = React.useState('');
  const [activeFilter, setActiveFilter] = React.useState('all');
  const [selectedRowId, setSelectedRowId] = React.useState<string | null>(null);
  const [curatingQuery, setCuratingQuery] = React.useState<string | null>(null);
  const config = readBrowseSurfaceConfig(browseConfig);
  const view = readCatalogView(catalog, config);
  const visibleCards = filterCatalogCards(view.cards, query, activeFilter);
  const replacementResults = searchReplacementCatalog(view.discovery.replacement_catalog, query);
  const visibleFilters = readStorefrontFilters(view.filters, config, activeFilter);
  const selectedCard = selectedRowId
    ? view.cards.find((card) => card.row_id === selectedRowId) ?? null
    : null;
  const loading = catalog == null;

  React.useEffect(() => {
    const readSelectedRow = () => {
      const params = new URLSearchParams(window.location.search);
      setSelectedRowId(params.get('package'));
    };

    readSelectedRow();
    window.addEventListener('popstate', readSelectedRow);
    return () => window.removeEventListener('popstate', readSelectedRow);
  }, []);

  const selectCard = (card: CatalogCardView) => {
    setSelectedRowId(card.row_id);
    const url = new URL(window.location.href);
    url.searchParams.set('package', card.row_id);
    window.history.pushState(null, '', url);
  };

  const clearSelectedCard = () => {
    setSelectedRowId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('package');
    window.history.pushState(null, '', url);
  };

  const handleCurateViaAI = (searchQuery: string) => {
    setCuratingQuery(searchQuery);
  };

  const handleSelectCuratedPackages = (packageIds: string[]) => {
    // Map curated package IDs to actual packages and initiate checkout
    const curatedCards = view.cards.filter((card) => packageIds.includes(card.row_id));
    if (curatedCards.length > 0) {
      selectCard(curatedCards[0]);
      setCuratingQuery(null);
    }
  };

  return (
    <section
      className="h-full w-full overflow-auto bg-[var(--surface-base)] px-4 py-8 text-[var(--text-primary)] sm:px-7 lg:px-10"
    >
      {curatingQuery ? (
        <AICurationPanelComponent
          curatingQuery={curatingQuery}
          catalogPackages={view.cards.map((card) => ({
            id: card.row_id,
            name: card.display_name,
            summary: card.summary,
            price: card.price_label,
          }))}
          onBack={() => setCuratingQuery(null)}
          onSelectPackages={handleSelectCuratedPackages}
        />
      ) : selectedCard ? (
        <PackageDetail
          actionCapabilities={actionCapabilities}
          browseConfig={config}
          card={selectedCard}
          installDestinations={installDestinations}
          relatedCards={readRelatedCards(view.cards, selectedCard)}
          onBack={clearSelectedCard}
        />
      ) : (
        <PackageGallery
          activeFilter={activeFilter}
          browseConfig={config}
          discovery={view.discovery}
          filters={visibleFilters}
          heroCards={view.cards}
          loading={loading}
          query={query}
          replacementResults={replacementResults}
          totalCount={view.cards.length}
          visibleCards={visibleCards}
          onCurateViaAI={handleCurateViaAI}
          onExploreComposition={(compositionQuery) => {
            setActiveFilter('all');
            setQuery(compositionQuery);
          }}
          onFilterChange={setActiveFilter}
          onQueryChange={setQuery}
          onSelectCard={selectCard}
        />
      )}
    </section>
  );
}

function PackageGallery({
  activeFilter,
  browseConfig,
  discovery,
  filters,
  heroCards,
  loading,
  query,
  replacementResults,
  totalCount,
  visibleCards,
  onFilterChange,
  onQueryChange,
  onSelectCard,
  onCurateViaAI,
  onExploreComposition,
}: {
  activeFilter: string;
  browseConfig: BrowseSurfaceConfig;
  discovery: CatalogDiscoveryView;
  filters: CatalogFilter[];
  heroCards: CatalogCardView[];
  loading: boolean;
  query: string;
  replacementResults: CatalogReplacementSearchResult[];
  totalCount: number;
  visibleCards: CatalogCardView[];
  onFilterChange: (filter: string) => void;
  onQueryChange: (query: string) => void;
  onSelectCard: (card: CatalogCardView) => void;
  onCurateViaAI: (query: string) => void;
  onExploreComposition: (query: string) => void;
}) {
  const [searchFocused, setSearchFocused] = React.useState(false);
  const showingDiscoveryHome = !loading && activeFilter === 'all' && query.trim().length === 0;

  return (
    <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-14 pt-8 sm:pt-12 lg:pt-16">
      <StorefrontHero
        activeFilter={activeFilter}
        browseConfig={browseConfig}
        cards={heroCards}
        filters={filters}
        query={query}
        searchFocused={searchFocused}
        onFilterChange={onFilterChange}
        onQueryChange={onQueryChange}
        onSearchBlur={() => setSearchFocused(false)}
        onSearchFocus={() => setSearchFocused(true)}
        onSelectMode={(mode, selectedQuery) => {
          if (mode === 'ask_ai') {
            onCurateViaAI(selectedQuery ?? query);
          }
        }}
      />

      {loading ? (
        <CatalogSkeleton />
      ) : showingDiscoveryHome ? (
        <DiscoveryHome
          cards={visibleCards}
          discovery={discovery}
          totalCount={totalCount}
          onCurateViaAI={onCurateViaAI}
          onExploreComposition={onExploreComposition}
          onFilterChange={onFilterChange}
          onSelectCard={onSelectCard}
        />
      ) : (
        <BrowseResultSection
          activeFilter={activeFilter}
          cards={visibleCards}
          discovery={discovery}
          totalCount={totalCount}
          query={query}
          replacementResults={replacementResults}
          onFilterChange={onFilterChange}
          onQueryChange={onQueryChange}
          onSelectCard={onSelectCard}
        />
      )}
    </div>
  );
}

function StackReplacementHero({
  onCurateViaAI,
}: {
  onCurateViaAI: (query: string) => void;
}) {
  const [value, setValue] = React.useState('');
  const examples = [
    'Replace Zapier, Notion, and Airtable',
    'Run my whole business autonomously',
    'Everything a tennis coaching studio needs',
    'Newsletter, CRM, and scheduling',
  ];
  const submit = (candidate: string) => {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) onCurateViaAI(trimmed);
  };

  return (
    <Card variant="nested" padding="lg" layout="stack">
      <Container layout="vertical" gap="md">
        <Badge variant="primary" size="sm">Curate with AI</Badge>
        <Text variant="heading-xl">Tell us your stack. Get the packages that replace it.</Text>
        <Text variant="body-lg" color="muted" leading="relaxed">
          Describe the software you pay for, or what you want to build. The AI finds the exact packages, shows what each one replaces, and lets you download the whole set at once.
        </Text>
        <Container layout="horizontal" gap="sm">
          <Input
            value={value}
            placeholder="e.g. Replace Zapier, Notion, and Airtable for my agency"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit(value);
            }}
          />
          <Button variant="primary" size="md" onClick={() => submit(value)}>
            Curate my stack
          </Button>
        </Container>
        <Container layout="horizontal" gap="sm">
          {examples.map((example) => (
            <Button
              key={example}
              variant="ghost"
              size="sm"
              onClick={() => {
                setValue(example);
                submit(example);
              }}
            >
              {example}
            </Button>
          ))}
        </Container>
      </Container>
    </Card>
  );
}

function DiscoveryHome({
  cards,
  discovery,
  totalCount,
  onCurateViaAI,
  onExploreComposition,
  onFilterChange,
  onSelectCard,
}: {
  cards: CatalogCardView[];
  discovery: CatalogDiscoveryView;
  totalCount: number;
  onCurateViaAI: (query: string) => void;
  onExploreComposition: (query: string) => void;
  onFilterChange: (filter: string) => void;
  onSelectCard: (card: CatalogCardView) => void;
}) {
  const shelves = discovery.shelves.filter((shelf) => shelf.card_ids.length > 0);

  return (
    <section className="grid gap-16" data-package-store-discovery-home>
      <StackReplacementHero onCurateViaAI={onCurateViaAI} />
      <GallerySectionHeader
        eyebrow="Bitfield Package Store"
        title="Discover"
        detail={`${totalCount} packages`}
      />
      <CategoryRailSection
        categories={discovery.category_rails}
        onFilterChange={onFilterChange}
      />
      <FounderCapabilityDiscovery
        catalog={discovery.replacement_catalog}
        onExplore={onExploreComposition}
        onSelectCard={onSelectCard}
      />
      {shelves.map((shelf, shelfIndex) => (
        <AppStoreShelfSection
          key={shelf.id}
          cards={cardsForShelf(cards, shelf, shelfIndex === 0 ? 6 : 8)}
          shelf={shelf}
          variant={shelfIndex === 0 ? 'feature' : 'list'}
          onFilterChange={onFilterChange}
          onSelectCard={onSelectCard}
        />
      ))}
    </section>
  );
}

function FounderCapabilityDiscovery({
  catalog,
  onExplore,
  onSelectCard,
}: {
  catalog: CatalogDiscoveryView['replacement_catalog'];
  onExplore: (query: string) => void;
  onSelectCard: (card: CatalogCardView) => void;
}) {
  if (catalog.compositions.length === 0) return null;

  return (
    <section className="grid gap-5" data-package-store-founder-capability-discovery>
      <div className="grid max-w-[760px] gap-1">
        <Text variant="heading-xl" className="tracking-[-0.055em]">
          Replace a stack. Keep the pieces.
        </Text>
        <Text variant="body" color="muted" leading="relaxed">
          Start with the software job. Each composition shows verified package pieces, comparison scope, migration evidence, and what is still missing.
        </Text>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        {catalog.compositions.map((composition) => (
          <Card
            key={composition.id}
            variant="nested"
            padding="lg"
            layout="stack"
            className="gap-5 border-[var(--border-primary)] bg-[var(--glass-bg-primary)]"
            data-package-store-founder-composition={composition.id}
          >
            <div className="grid gap-2">
              <Badge variant="neutral" size="sm" className="w-fit">
                {composition.label}
              </Badge>
              <Text variant="heading-lg" className="tracking-[-0.04em]">
                {composition.founder_problem}
              </Text>
              <Text variant="body-sm" color="muted" leading="relaxed">
                {composition.claim}
              </Text>
            </div>
            <div className="grid gap-2">
              <Text variant="caption" color="faint" className="uppercase tracking-[0.14em]">
                Built from
              </Text>
              <div className="grid gap-2 sm:grid-cols-2">
                {composition.proof_cards.map(({ card, package_identity, role }) => (
                  <button
                    key={package_identity}
                    className="grid gap-1 rounded-lg border border-[var(--border-primary)] bg-[var(--surface-base)] p-3 text-left transition hover:-translate-y-0.5 hover:border-[var(--border-secondary)]"
                    onClick={() => onSelectCard(card)}
                    type="button"
                  >
                    <Text variant="caption" color="faint">{role}</Text>
                    <Text variant="heading" truncate>{card.display_name}</Text>
                  </button>
                ))}
              </div>
              {composition.missing_package_identities.length > 0 ? (
                <Text variant="caption" color="faint">
                  Some pieces are not listed in this catalog yet.
                </Text>
              ) : null}
              {composition.competitors.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Text variant="caption" color="faint">Comparable jobs</Text>
                  {composition.competitors.map((competitor) => (
                    <LogoMark key={competitor.id} competitor={competitor} />
                  ))}
                </div>
              ) : null}
              <Text variant="caption" color="muted" leading="relaxed">
                Supports: {composition.supported_job}
              </Text>
              {composition.gaps.length > 0 ? (
                <Text variant="caption" color="faint" leading="relaxed">
                  Boundary: {composition.gaps[0]}
                </Text>
              ) : null}
              <CompositionEvidence composition={composition} />
            </div>
            <Button
              className="w-fit"
              size="sm"
              variant="secondary"
              onClick={() => onExplore(composition.cta.query)}
              type="button"
            >
              {composition.cta.label}
            </Button>
          </Card>
        ))}
      </div>
    </section>
  );
}

function CategoryRailSection({
  categories,
  onFilterChange,
}: {
  categories: CatalogDiscoveryView['category_rails'];
  onFilterChange: (filter: string) => void;
}) {
  if (categories.length === 0) return null;

  return (
    <section className="grid gap-4" data-package-store-category-rails>
      <div className="flex items-end justify-between gap-4">
        <div className="grid gap-1">
          <Text variant="heading-lg" className="tracking-[-0.045em]">
            Browse by need
          </Text>
          <Text variant="body-xs" color="muted">
            Pick the job first. The package list follows.
          </Text>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {categories.map((category) => (
          <button
            key={category.id}
            className="group grid min-h-[130px] content-between rounded-xl border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] p-4 text-left shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-[var(--border-secondary)] hover:bg-[var(--glass-bg-hover)]"
            data-package-store-category-rail={category.id}
            onClick={() => onFilterChange(category.filter_id)}
            type="button"
          >
            <span className="flex items-start justify-between gap-3">
              <Text variant="heading-lg" className="tracking-[-0.045em]">
                {category.label}
              </Text>
              <Badge variant="neutral" size="sm" tabIndex={-1}>
                {category.count}
              </Badge>
            </span>
            <Text variant="body-xs" color="muted" leading="relaxed">
              {category.description}
            </Text>
          </button>
        ))}
      </div>
    </section>
  );
}

function AppStoreShelfSection({
  cards,
  shelf,
  variant,
  onFilterChange,
  onSelectCard,
}: {
  cards: CatalogCardView[];
  shelf: CatalogDiscoveryShelfView;
  variant: 'feature' | 'list';
  onFilterChange: (filter: string) => void;
  onSelectCard: (card: CatalogCardView) => void;
}) {
  if (cards.length === 0) return null;

  return (
    <section className="grid gap-5" data-package-store-discovery-shelf={shelf.id}>
      <div className="flex items-end justify-between gap-4">
        <div className="grid gap-1">
          <Text variant="heading-xl" className="tracking-[-0.055em]">
            {shelf.label}
          </Text>
          <Text variant="body" color="muted">
            {shelf.description}
          </Text>
        </div>
        <button
          className="hidden shrink-0 items-center gap-2 text-sm font-medium text-[var(--status-info)] transition-colors hover:text-[var(--text-primary)] sm:inline-flex"
          onClick={() => onFilterChange(shelf.filter_id)}
          type="button"
        >
          See all
          <span aria-hidden="true">›</span>
        </button>
      </div>

      {variant === 'feature' ? (
        <div className="grid gap-7 lg:grid-cols-3">
          {cards.slice(0, 3).map((card, index) => (
            <EditorialFeatureCard
              key={card.row_id}
              card={card}
              index={index}
              onSelect={() => onSelectCard(card)}
            />
          ))}
        </div>
      ) : (
        <div className="grid gap-x-8 gap-y-5 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((card, index) => (
            <PackageListTile
              key={card.row_id}
              card={card}
              index={index}
              onSelect={() => onSelectCard(card)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function BrowseResultSection({
  activeFilter,
  cards,
  discovery,
  query,
  replacementResults,
  totalCount,
  onFilterChange,
  onQueryChange,
  onSelectCard,
}: {
  activeFilter: string;
  cards: CatalogCardView[];
  discovery: CatalogDiscoveryView;
  query: string;
  replacementResults: CatalogReplacementSearchResult[];
  totalCount: number;
  onFilterChange: (filter: string) => void;
  onQueryChange: (query: string) => void;
  onSelectCard: (card: CatalogCardView) => void;
}) {
  const heading = readResultHeading(discovery, activeFilter);

  return (
    <section className="grid gap-7">
      <GallerySectionHeader
        eyebrow={heading.eyebrow}
        title={heading.title}
        detail={`${cards.length} of ${totalCount} packages`}
      />
      {heading.description ? (
        <Text variant="body-lg" color="muted" leading="relaxed" className="max-w-[720px]">
          {heading.description}
        </Text>
      ) : null}

      <ReplacementSearchSection
        cards={cards.slice(0, 4)}
        catalog={discovery.replacement_catalog}
        query={query}
        results={replacementResults}
        onExplore={onQueryChange}
        onSelectCard={onSelectCard}
      />

      {cards.length > 0 ? (
        <div className="grid gap-x-10 gap-y-16 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((card, index) => (
            <PackageGalleryCard
              key={card.row_id}
              card={card}
              index={index}
              onSelect={() => onSelectCard(card)}
            />
          ))}
        </div>
      ) : (
        <NoResultRecovery
          suggestions={discovery.recovery_suggestions}
          onFilterChange={onFilterChange}
          onQueryChange={onQueryChange}
        />
      )}
    </section>
  );
}

function ReplacementSearchSection({
  cards,
  catalog,
  query,
  results,
  onExplore,
  onSelectCard,
}: {
  cards: CatalogCardView[];
  catalog: CatalogDiscoveryView['replacement_catalog'];
  query: string;
  results: CatalogReplacementSearchResult[];
  onExplore: (query: string) => void;
  onSelectCard: (card: CatalogCardView) => void;
}) {
  if (!query.trim()) return null;

  if (results.length === 0) {
    return (
      <section className="grid gap-4" data-package-store-replacement-unsupported>
        <Card variant="nested" padding="lg" layout="stack" className="gap-4 border-[var(--border-primary)] bg-[var(--glass-bg-primary)]">
          <div className="grid gap-2">
            <Badge variant="neutral" size="sm" className="w-fit">Not present in this catalog</Badge>
            <Text variant="heading-lg" className="tracking-[-0.04em]">
              This capability is not present in the current catalog.
            </Text>
            <Text variant="body-sm" color="muted" leading="relaxed">
              The matcher found no supported composition for “{query}”. These are the closest verified primitives, not a claimed replacement.
            </Text>
          </div>
          {cards.length > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {cards.map((card) => (
                <button
                  key={card.row_id}
                  className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface-base)] p-3 text-left hover:border-[var(--border-secondary)]"
                  onClick={() => onSelectCard(card)}
                  type="button"
                >
                  <Text variant="heading" truncate>{card.display_name}</Text>
                  <Text variant="caption" color="muted">{card.summary}</Text>
                </button>
              ))}
            </div>
          ) : null}
          <RequestToBuildPanel catalog={catalog} />
        </Card>
      </section>
    );
  }

  return (
    <section className="grid gap-4" data-package-store-replacement-results>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <Text variant="heading-lg" className="tracking-[-0.04em]">Relevant compositions</Text>
          <Text variant="body-xs" color="muted">Ranked from supported jobs, aliases, package proof, and comparison categories.</Text>
        </div>
        <Badge variant="neutral" size="sm">{results.length} matches</Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {results.map((result) => (
          <Card key={result.composition.id} variant="nested" padding="lg" layout="stack" className="gap-4 border-[var(--border-primary)] bg-[var(--glass-bg-primary)]">
            <div className="grid gap-2">
              <Badge variant="neutral" size="sm" className="w-fit">{result.composition.label}</Badge>
              <Text variant="heading-lg" className="tracking-[-0.04em]">{result.composition.supported_job}</Text>
              <Text variant="body-sm" color="muted" leading="relaxed">{result.composition.claim}</Text>
            </div>
            <div className="flex flex-wrap gap-2">
              {result.matched_fields.map((field) => <Badge key={field} variant="neutral" size="sm">{field}</Badge>)}
            </div>
            <Text variant="caption" color="faint">
              Matched: {result.matched_terms.join(', ')} · Score {result.score}
            </Text>
            <div className="flex flex-wrap gap-2">
              {result.composition.proof_cards.slice(0, 4).map(({ card, package_identity, role }) => (
                <button
                  key={package_identity}
                  className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface-base)] px-3 py-2 text-left hover:border-[var(--border-secondary)]"
                  onClick={() => onSelectCard(card)}
                  type="button"
                >
                  <Text variant="caption" color="faint">{role}</Text>
                  <Text variant="heading" truncate>{card.display_name}</Text>
                </button>
              ))}
            </div>
            {result.composition.competitors.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {result.composition.competitors.map((competitor) => <LogoMark key={competitor.id} competitor={competitor} />)}
              </div>
            ) : null}
            <CompositionEvidence composition={result.composition} />
            <Button className="w-fit" size="sm" variant="secondary" onClick={() => onExplore(result.composition.cta.query)} type="button">
              {result.composition.cta.label}
            </Button>
          </Card>
        ))}
      </div>
    </section>
  );
}

function CompositionEvidence({ composition }: { composition: CatalogCapabilityCompositionView }) {
  return (
    <details className="grid gap-2 border-t border-[var(--border-primary)] pt-3">
      <summary className="cursor-pointer text-sm font-semibold text-[var(--text-secondary)]">
        Compare scope and migration
      </summary>
      <div className="grid gap-2 pt-1">
        <Text variant="caption" color="muted" leading="relaxed">
          Comparable jobs: {composition.comparison.comparable_categories.join(', ') || 'No comparable category recorded'}
        </Text>
        <Text variant="caption" color="muted" leading="relaxed">
          Includes: {composition.comparison.included_work.join(', ') || 'No included work recorded'}
        </Text>
        <Text variant="caption" color="faint" leading="relaxed">
          Does not include: {composition.comparison.excluded_work.join(', ') || 'No exclusions recorded'}
        </Text>
        {composition.integration_requirements.length > 0 ? (
          <Text variant="caption" color="muted" leading="relaxed">
            Setup: {composition.integration_requirements.map(({ requirement }) => requirement).join(' ')}
          </Text>
        ) : null}
        <Text variant="caption" color="muted" leading="relaxed">
          Economics: cost {composition.economics.cost.status}; time {composition.economics.time.status}. {composition.economics.compounding_value.rationale}
        </Text>
        {composition.migration_path.length > 0 ? (
          <Text variant="caption" color="muted" leading="relaxed">
            Migration: {composition.migration_path.join(' ')}
          </Text>
        ) : null}
      </div>
    </details>
  );
}

function RequestToBuildPanel({ catalog }: { catalog: CatalogDiscoveryView['replacement_catalog'] }) {
  const [submitted, setSubmitted] = React.useState(false);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const fields = catalog.request_to_build.fields.length > 0
    ? catalog.request_to_build.fields
    : [{ id: 'capability_request', label: 'What should it do?', required: true }];
  const updateValue = (fieldId: string, value: string) => {
    setValues((current) => ({ ...current, [fieldId]: value }));
    setSubmitted(false);
  };
  const requiredFieldsReady = fields.every((field) => !field.required || values[field.id]?.trim());

  return (
    <form
      className="grid gap-3 border-t border-[var(--border-primary)] pt-4"
      data-request-target={catalog.request_to_build.target}
      onSubmit={(event) => {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('bitfield:replacement-request', {
          detail: {
            target: catalog.request_to_build.target,
            ...values,
          },
        }));
        setSubmitted(true);
      }}
    >
      <div className="grid gap-1">
        <Text variant="heading">Request the missing composition</Text>
        <Text variant="caption" color="muted">{catalog.request_to_build.description}</Text>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field, index) => (
          <Input
            key={field.id}
            aria-label={field.label}
            className={index === 0 ? 'sm:col-span-2' : undefined}
            placeholder={field.label}
            required={field.required}
            value={values[field.id] ?? ''}
            onChange={(event) => updateValue(field.id, event.target.value)}
          />
        ))}
      </div>
      <Button className="w-fit" size="sm" variant="secondary" type="submit" disabled={!requiredFieldsReady}>
        {submitted ? 'Request prepared' : catalog.request_to_build.label}
      </Button>
    </form>
  );
}

function readResultHeading(discovery: CatalogDiscoveryView, activeFilter: string) {
  const category = discovery.category_rails.find((candidate) => candidate.filter_id === activeFilter);
  if (category) {
    return {
      eyebrow: 'Category',
      title: category.label,
      description: category.description,
    };
  }

  const shelf = discovery.shelves.find((candidate) => candidate.filter_id === activeFilter);
  if (shelf) {
    return {
      eyebrow: 'Shelf',
      title: shelf.label,
      description: shelf.description,
    };
  }

  return {
    eyebrow: 'Results',
    title: 'Packages',
    description: '',
  };
}

function EditorialFeatureCard({
  card,
  index,
  onSelect,
}: {
  card: CatalogCardView;
  index: number;
  onSelect: () => void;
}) {
  const signals = readCardSignals(card, index);

  return (
    <article className="group" data-package-store-editorial-card={card.row_id}>
      <button
        aria-label={`Open ${card.display_name}`}
        className="grid w-full gap-3 text-left"
        onClick={onSelect}
        type="button"
      >
        <div className="overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] transition duration-200 group-hover:-translate-y-1 group-hover:border-[var(--border-secondary)]">
          <PackageTileArt card={card} mode="gallery" />
        </div>
        <div className="grid gap-1">
          <Text variant="heading-lg" truncate className="tracking-[-0.04em]">
            {card.display_name}
          </Text>
          <Text variant="body-xs" color="muted" truncate>
            by {card.creator_label} • {card.price_label}
          </Text>
          <div className="flex gap-3 pt-1 text-xs text-[var(--text-muted)]">
            <span>♡ {signals.records}</span>
            <span>♙ {signals.capabilities}</span>
          </div>
        </div>
      </button>
    </article>
  );
}

function PackageListTile({
  card,
  index,
  onSelect,
}: {
  card: CatalogCardView;
  index: number;
  onSelect: () => void;
}) {
  const signals = readCardSignals(card, index);

  return (
    <article className="group border-t border-[var(--border-primary)] pt-5" data-package-store-list-tile={card.row_id}>
      <button
        aria-label={`Open ${card.display_name}`}
        className="grid w-full grid-cols-[92px_minmax(0,1fr)_auto] items-center gap-4 text-left"
        onClick={onSelect}
        type="button"
      >
        <div className="overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-primary)]">
          <PackageTileArt card={card} mode="mini" />
        </div>
        <div className="min-w-0">
          <Text variant="heading" truncate className="tracking-[-0.035em]">
            {card.display_name}
          </Text>
          <Text variant="body-xs" color="muted" truncate className="mt-1">
            {card.summary}
          </Text>
          <Text variant="caption" color="faint" className="mt-2">
            {signals.records} records • {signals.capabilities} capabilities
          </Text>
        </div>
        <Badge variant="neutral" size="lg" tabIndex={-1}>
          {card.price_label}
        </Badge>
      </button>
    </article>
  );
}

function NoResultRecovery({
  suggestions,
  onFilterChange,
  onQueryChange,
}: {
  suggestions: CatalogDiscoveryView['recovery_suggestions'];
  onFilterChange: (filter: string) => void;
  onQueryChange: (query: string) => void;
}) {
  return (
    <div data-package-store-no-result-recovery>
      <Card
        variant="nested"
        padding="lg"
        layout="stack"
        className="min-h-[260px] justify-center"
      >
        <div>
          <Text variant="heading-2xl" className="tracking-[-0.06em]">No matching packages</Text>
          <Text variant="body-lg" color="muted" className="mt-3">
            Try one of these paths.
          </Text>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              className="grid gap-2 rounded-none border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] p-4 text-left transition hover:border-[var(--border-secondary)] hover:bg-[var(--glass-bg-hover)]"
              onClick={() => {
                onFilterChange(suggestion.filter_id);
                onQueryChange(suggestion.query);
              }}
              type="button"
            >
              <Text variant="heading">
                {suggestion.label}
              </Text>
              <Text variant="body-xs" color="muted" leading="relaxed">
                {suggestion.description}
              </Text>
            </button>
          ))}
        </div>
      </Card>
    </div>
  );
}

function cardsForShelf(
  cards: CatalogCardView[],
  shelf: CatalogDiscoveryShelfView,
  limit: number,
) {
  const cardsById = new Map(cards.map((card) => [card.row_id, card]));
  const fromShelfIds = shelf.card_ids
    .map((rowId) => cardsById.get(rowId))
    .filter((card): card is CatalogCardView => Boolean(card));
  const fallback = cards.filter((card) => card.filter_ids.includes(shelf.filter_id));
  return (fromShelfIds.length > 0 ? fromShelfIds : fallback).slice(0, limit);
}

function StorefrontHero({
  activeFilter,
  browseConfig,
  cards,
  filters,
  query,
  searchFocused,
  onFilterChange,
  onQueryChange,
  onSearchBlur,
  onSearchFocus,
  onSelectMode,
}: {
  activeFilter: string;
  browseConfig: BrowseSurfaceConfig;
  cards: CatalogCardView[];
  filters: CatalogFilter[];
  query: string;
  searchFocused: boolean;
  onFilterChange: (filter: string) => void;
  onQueryChange: (query: string) => void;
  onSearchBlur: () => void;
  onSearchFocus: () => void;
  onSelectMode?: (mode: string, query?: string) => void;
}) {
  const pointillistCards = cards
    .filter((card): card is PointillistPreviewCard => isPointillistPreviewArt(card.preview_art))
    .slice(0, 18);

  return (
    <section className="mx-auto grid w-full max-w-[1480px] gap-7">
      <div className="mx-auto grid max-w-[760px] justify-items-center text-center">
        <Text variant="heading-2xl" className="text-[clamp(1.8rem,3.3vw,2.75rem)] tracking-[-0.06em]">
          Find packages and ready-made bundles for your product.
        </Text>
      </div>

      <div className="mx-auto grid w-full max-w-[760px] gap-3">
        <div className="relative">
          <Input
            aria-label="Search packages"
            value={query}
            icon={<SearchIcon />}
            onBlur={onSearchBlur}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            onFocus={onSearchFocus}
            placeholder={searchFocused ? '' : 'Search packages and bundles'}
            className="h-11 !rounded-none border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] pl-10 pr-4 text-left text-sm placeholder:text-left focus-visible:ring-1 focus-visible:ring-[var(--status-info)]"
          />
          <SearchSuggestionPopover
            browseConfig={browseConfig}
            cards={cards}
            visible={searchFocused}
            query={query}
            onFilterChange={onFilterChange}
            onQueryChange={onQueryChange}
            onSelectMode={onSelectMode}
          />
        </div>
        <FilterRail
          activeFilter={activeFilter}
          filters={filters}
          onChange={onFilterChange}
        />
        <SurfaceActionRail actions={browseConfig.surface_actions} />
      </div>

      <HeroPointillistSceneRotator cards={pointillistCards} sceneConfigs={browseConfig.hero_scenes} />
    </section>
  );
}

function SurfaceActionRail({ actions }: { actions: BrowseSurfaceActionConfig[] }) {
  if (actions.length === 0) return null;

  return (
    <div className="mx-auto flex max-w-full flex-wrap justify-center gap-2 pt-1">
      {actions.map((action, index) => (
        <a
          key={action.id}
          className={buttonVariants({
            variant: index === 0 ? 'secondary' : 'primary',
            size: 'md',
            radius: 'none',
          })}
          href={action.href}
        >
          {action.label}
        </a>
      ))}
    </div>
  );
}

function SearchSuggestionPopover({
  browseConfig,
  cards,
  visible,
  query,
  onFilterChange,
  onQueryChange,
  onSelectMode,
}: {
  browseConfig: BrowseSurfaceConfig;
  cards: CatalogCardView[];
  visible: boolean;
  query: string;
  onFilterChange: (filter: string) => void;
  onQueryChange: (query: string) => void;
  onSelectMode?: (mode: string, query?: string) => void;
}) {
  const suggestions = readSearchSuggestions(cards, browseConfig.search_suggestions);

  if (!visible) return null;

  const handleSelectMode = (modeId: string) => {
    if (modeId === 'ask_ai' && onSelectMode) {
      onSelectMode(modeId, query);
    } else if (onSelectMode) {
      onSelectMode(modeId, query);
    }
  };

  return (
    <div
      className="absolute left-0 right-0 top-[calc(100%+10px)] z-30 overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] shadow-2xl"
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="grid gap-6 p-5">
        <section className="grid gap-3">
          {query.trim().length > 0 ? (
            <SearchModeRow modes={SEARCH_MODES} query={query} onSelectMode={handleSelectMode} />
          ) : null}
          <Text variant="body" color="muted">
            Popular searches
          </Text>
          <div className="flex flex-wrap gap-2">
            {browseConfig.popular_searches.map((suggestion) => (
              <button
                key={suggestion}
                className="inline-flex items-center gap-2 rounded-md border border-[var(--border-primary)] px-3 py-2 text-sm text-[var(--text-secondary)] transition hover:bg-[var(--glass-bg-hover)] hover:text-[var(--text-primary)]"
                onClick={() => onQueryChange(suggestion)}
                type="button"
              >
                <span aria-hidden="true">↗</span>
                {suggestion}
              </button>
            ))}
          </div>
        </section>

        <section className="grid gap-3">
          <Text variant="body" color="muted">
            Browse categories
          </Text>
          <div className="grid gap-2">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.label}
                className="grid grid-cols-[92px_minmax(0,1fr)] items-center overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] text-left transition hover:bg-[var(--glass-bg-hover)]"
                onClick={() => {
                  onFilterChange(suggestion.filterId);
                  onQueryChange(suggestion.query);
                }}
                type="button"
              >
                <div className="relative h-16 overflow-hidden bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)]">
                  {suggestion.card && isPointillistPreviewArt(suggestion.card.preview_art) ? (
                    <PointillistPackagePreviewCanvas
                      frameUrl={suggestion.card.preview_art.data_url}
                      className="h-full w-full"
                    />
                  ) : null}
                </div>
                <div className="min-w-0 px-4">
                  <Text variant="heading" truncate>
                    {suggestion.label}
                  </Text>
                  <Text variant="body-xs" color="muted" truncate className="mt-1 text-sm">
                    {suggestion.description}
                  </Text>
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function HeroPointillistSceneRotator({
  cards,
  sceneConfigs,
}: {
  cards: PointillistPreviewCard[];
  sceneConfigs: BrowseHeroSceneConfig[];
}) {
  const scenes = readHeroScenes(cards, sceneConfigs);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [previousIndex, setPreviousIndex] = React.useState<number | null>(null);

  React.useEffect(() => {
    setActiveIndex((current) => (current < scenes.length ? current : 0));
  }, [scenes.length]);

  React.useEffect(() => {
    if (scenes.length <= 1) return;
    const interval = window.setInterval(() => {
      setActiveIndex((current) => {
        setPreviousIndex(current);
        return (current + 1) % scenes.length;
      });
    }, 5000);

    return () => window.clearInterval(interval);
  }, [scenes.length]);

  React.useEffect(() => {
    if (previousIndex == null) return;
    const timeout = window.setTimeout(() => setPreviousIndex(null), 760);
    return () => window.clearTimeout(timeout);
  }, [previousIndex]);

  if (scenes.length === 0) {
    return (
      <div
        className="h-[clamp(128px,16vw,190px)] overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] shadow-2xl"
        aria-hidden="true"
      />
    );
  }

  const visibleScenes = readVisibleHeroScenes(scenes, activeIndex, previousIndex);

  return (
    <div
      className="package-store-hero-rotator relative h-[clamp(128px,16vw,190px)] overflow-hidden rounded-2xl border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] shadow-2xl"
      aria-label="Package Store visual examples"
    >
      {visibleScenes.map(({ phase, scene, sceneIndex }) => (
        <div
          key={`${phase}:${scene.id}`}
          className={`package-store-hero-scene absolute inset-0 ${phase === 'previous' ? 'package-store-hero-scene-exit' : 'package-store-hero-scene-enter'}`}
        >
          <PointillistPackagePreviewCanvas
            frameUrl={scene.background.preview_art.data_url}
            className="package-store-hero-background-canvas h-full w-full scale-[1.1] opacity-40"
          />
          <div className="package-store-hero-overlay absolute inset-0 bg-[rgba(31,31,31,0.46)]" />
          <div className="package-store-hero-copy absolute left-[5%] top-1/2 z-10 hidden -translate-y-1/2 sm:grid">
            <Text variant="heading" className="text-[var(--text-primary)]">
              {scene.title}
            </Text>
            <Text variant="body-xs" color="muted" className="mt-1 max-w-[260px] text-sm">
              {scene.description}
            </Text>
          </div>
          {scene.cards.map((card, cardIndex) => (
            <div
              key={`${scene.id}:${card.visual_key}`}
              className={readHeroScenePreviewClass(sceneIndex, cardIndex)}
            >
              <PointillistPackagePreviewCanvas
                frameUrl={card.preview_art.data_url}
                className="package-store-hero-preview-canvas h-full w-full opacity-95"
              />
            </div>
          ))}
        </div>
      ))}
      <style>{`
        .package-store-hero-rotator {
          position: relative;
          height: clamp(128px, 16vw, 190px);
          overflow: hidden;
        }

        .package-store-hero-scene,
        .package-store-hero-background-canvas,
        .package-store-hero-overlay {
          position: absolute;
          inset: 0;
        }

        .package-store-hero-background-canvas {
          width: 100%;
          height: 100%;
          scale: 1.1;
          opacity: 0.4;
        }

        .package-store-hero-overlay {
          background: rgba(31, 31, 31, 0.46);
        }

        .package-store-hero-copy {
          position: absolute;
          left: 5%;
          top: 50%;
          z-index: 10;
          transform: translateY(-50%);
        }

        @media (min-width: 640px) {
          .package-store-hero-copy {
            display: grid;
          }
        }

        .package-store-hero-preview {
          position: absolute;
          overflow: hidden;
          border: 1px solid var(--border-primary);
          border-radius: 0.75rem;
          background: color-mix(in srgb, var(--surface-base) 54%, var(--text-primary) 46%);
          box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25);
        }

        .package-store-hero-preview-canvas {
          width: 100%;
          height: 100%;
          opacity: 0.95;
        }

        .package-store-hero-preview--0-0 { left: 30%; top: 18%; width: 176px; height: 92px; rotate: -3deg; }
        .package-store-hero-preview--0-1 { left: 47%; top: 30%; width: 200px; height: 104px; rotate: 2deg; }
        .package-store-hero-preview--0-2 { right: 7%; top: 14%; width: 176px; height: 92px; rotate: -1deg; }
        .package-store-hero-preview--1-0 { left: 28%; top: 16%; width: 200px; height: 104px; rotate: 2deg; }
        .package-store-hero-preview--1-1 { left: 51%; top: 12%; width: 176px; height: 92px; rotate: -3deg; }
        .package-store-hero-preview--1-2 { right: 8%; top: 34%; width: 168px; height: 88px; rotate: 3deg; }
        .package-store-hero-preview--2-0 { left: 32%; top: 28%; width: 168px; height: 88px; rotate: 1deg; }
        .package-store-hero-preview--2-1 { left: 49%; top: 16%; width: 200px; height: 104px; rotate: -2deg; }
        .package-store-hero-preview--2-2 { right: 9%; top: 18%; width: 176px; height: 92px; rotate: 2deg; }

        @media (max-width: 639.98px) {
          .package-store-hero-preview--0-1,
          .package-store-hero-preview--0-2,
          .package-store-hero-preview--1-1,
          .package-store-hero-preview--1-2,
          .package-store-hero-preview--2-1,
          .package-store-hero-preview--2-2 {
            display: none;
          }
        }

        @media (min-width: 640px) and (max-width: 1023.98px) {
          .package-store-hero-preview--0-2,
          .package-store-hero-preview--1-2,
          .package-store-hero-preview--2-2 {
            display: none;
          }
        }

        .package-store-hero-scene-enter {
          animation: package-store-hero-scene-enter 700ms ease both;
        }

        .package-store-hero-scene-exit {
          animation: package-store-hero-scene-exit 700ms ease both;
        }

        @keyframes package-store-hero-scene-enter {
          0% {
            opacity: 0;
            transform: translate3d(0, 6px, 0) scale(0.985);
          }

          100% {
            opacity: 1;
            transform: translate3d(0, 0, 0) scale(1);
          }
        }

        @keyframes package-store-hero-scene-exit {
          0% {
            opacity: 1;
            transform: translate3d(0, 0, 0) scale(1);
          }

          100% {
            opacity: 0;
            transform: translate3d(0, 6px, 0) scale(0.985);
          }
        }
      `}</style>
    </div>
  );
}

type HeroSceneView = ReturnType<typeof readHeroScenes>[number];

function readVisibleHeroScenes(
  scenes: HeroSceneView[],
  activeIndex: number,
  previousIndex: number | null,
) {
  const activeSceneIndex = activeIndex % scenes.length;
  const activeScene = scenes[activeSceneIndex];
  const previousSceneIndex = previousIndex == null ? null : previousIndex % scenes.length;
  const previousScene = previousSceneIndex == null || previousSceneIndex === activeSceneIndex
    ? null
    : scenes[previousSceneIndex];

  return [
    previousScene && previousSceneIndex != null
      ? { phase: 'previous' as const, scene: previousScene, sceneIndex: previousSceneIndex }
      : null,
    { phase: 'active' as const, scene: activeScene, sceneIndex: activeSceneIndex },
  ].filter((entry): entry is NonNullable<typeof entry> => entry != null);
}

function readHeroScenePreviewClass(sceneIndex: number, cardIndex: number) {
  const semanticClass = `package-store-hero-preview package-store-hero-preview--${sceneIndex % 3}-${cardIndex}`;
  const classes = [
    [
      'absolute left-[30%] top-[18%] h-[92px] w-[176px] -rotate-3 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)] shadow-2xl',
      'absolute left-[47%] top-[30%] hidden h-[104px] w-[200px] rotate-2 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)] shadow-2xl sm:block',
      'absolute right-[7%] top-[14%] hidden h-[92px] w-[176px] -rotate-1 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)] shadow-2xl lg:block',
    ],
    [
      'absolute left-[28%] top-[16%] h-[104px] w-[200px] rotate-2 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)] shadow-2xl',
      'absolute left-[51%] top-[12%] hidden h-[92px] w-[176px] -rotate-3 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)] shadow-2xl sm:block',
      'absolute right-[8%] top-[34%] hidden h-[88px] w-[168px] rotate-3 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)] shadow-2xl lg:block',
    ],
    [
      'absolute left-[32%] top-[28%] h-[88px] w-[168px] rotate-1 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)] shadow-2xl',
      'absolute left-[49%] top-[16%] hidden h-[104px] w-[200px] -rotate-2 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)] shadow-2xl sm:block',
      'absolute right-[9%] top-[18%] hidden h-[92px] w-[176px] rotate-2 overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[color-mix(in_srgb,var(--surface-base)_54%,var(--text-primary)_46%)] shadow-2xl lg:block',
    ],
  ];

  return `${semanticClass} ${classes[sceneIndex % classes.length][cardIndex] ?? classes[0][0]}`;
}

function readHeroScenes(cards: PointillistPreviewCard[], sceneConfigs: BrowseHeroSceneConfig[]) {
  return sceneConfigs
    .map((scene, sceneIndex) => {
      const sceneCards = scene.package_identities
        .map((name, nameIndex) => findHeroCard(cards, name) ?? cards[(sceneIndex * 4 + nameIndex) % cards.length])
        .filter((card): card is PointillistPreviewCard => Boolean(card));

      return {
        ...scene,
        background: sceneCards[0],
        cards: sceneCards.slice(1, 4),
      };
    })
    .filter((scene) => scene.background && scene.cards.length > 0);
}

function findHeroCard(cards: PointillistPreviewCard[], name: string) {
  return cards.find((card) => (
    card.identity === name ||
    card.row_id.includes(name) ||
    card.visual_key.includes(`:${name}:`)
  ));
}

function readSearchSuggestions(
  cards: CatalogCardView[],
  suggestions: BrowseSearchSuggestionConfig[],
) {
  return suggestions.map((suggestion) => ({
    label: suggestion.label,
    description: suggestion.description,
    filterId: suggestion.filter_id,
    query: suggestion.query,
    card: findSuggestionCard(cards, suggestion.package_identity ?? suggestion.query),
  }));
}

function findSuggestionCard(cards: CatalogCardView[], name: string) {
  return cards.find((card) => (
    card.identity === name ||
    card.row_id.includes(name) ||
    card.visual_key.includes(`:${name}:`)
  ));
}

function SearchIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      focusable="false"
      viewBox="0 0 16 16"
    >
      <circle cx="7" cy="7" r="4.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.25 10.25L13.5 13.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </svg>
  );
}

function GallerySectionHeader({ eyebrow, title, detail }: { eyebrow: string; title: string; detail: string }) {
  return (
    <header className="flex items-end justify-between gap-5">
      <div className="grid gap-2">
        <Text variant="overline" color="faint">
          {eyebrow}
        </Text>
        <Text variant="heading-xl" className="tracking-[-0.055em]">
          {title}
        </Text>
        {detail ? (
          <Text variant="body-xs" color="muted">
            {detail}
          </Text>
        ) : null}
      </div>
      <button
        className="hidden items-center gap-2 text-sm font-medium text-[var(--status-info)] transition-colors hover:text-[var(--text-primary)] sm:inline-flex"
        type="button"
      >
        Browse all packages
        <span aria-hidden="true">›</span>
      </button>
    </header>
  );
}

function PackageGalleryCard({
  card,
  index,
  onSelect,
}: {
  card: CatalogCardView;
  index: number;
  onSelect: () => void;
}) {
  const signals = readCardSignals(card, index);

  return (
    <article className="group min-w-0">
      <button
        aria-label={`Open ${card.display_name}`}
        className="grid w-full min-w-0 gap-3 text-left"
        onClick={onSelect}
        type="button"
      >
        <div className="overflow-hidden rounded-xl border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] transition duration-200 group-hover:-translate-y-1 group-hover:border-[var(--border-secondary)]">
          <PackageTileArt card={card} mode="gallery" />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-4">
          <div className="min-w-0">
            <Text variant="heading-lg" truncate className="text-[1.08rem] leading-tight tracking-[-0.035em]">
              {card.display_name}
            </Text>
            <Text variant="body-xs" color="muted" truncate className="mt-1 text-sm">
              by {card.creator_label} • {card.price_label}
            </Text>
          </div>
          <div className="flex shrink-0 items-end gap-3 pb-0.5 text-sm text-[var(--text-muted)]">
            <span aria-label={`${card.ref_count} records`}>♡ {signals.records}</span>
            <span aria-label={`${card.capabilities.length} capabilities`}>♙ {signals.capabilities}</span>
          </div>
        </div>
      </button>
    </article>
  );
}

function PackageDetail({
  actionCapabilities,
  browseConfig,
  card,
  installDestinations,
  relatedCards,
  onBack,
}: {
  actionCapabilities?: unknown;
  browseConfig: BrowseSurfaceConfig;
  card: CatalogCardView;
  installDestinations?: unknown;
  relatedCards: CatalogCardView[];
  onBack: () => void;
}) {
  const [accountSession, setAccountSession] = React.useState<AccountSessionView | null | undefined>(undefined);

  React.useEffect(() => {
    let cancelled = false;
    async function loadSession() {
      const session = await readPackageStoreAccountSession(actionCapabilities);
      if (!cancelled) setAccountSession(session);
    }

    void loadSession();
    return () => {
      cancelled = true;
    };
  }, [actionCapabilities]);

  return (
    <div className="mx-auto grid w-full max-w-[1320px] gap-9">
      <div className="flex items-center">
        <button
          className="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          onClick={onBack}
          type="button"
        >
          <span aria-hidden="true">‹</span>
          Package Store
        </button>
      </div>

      <div className="overflow-hidden rounded-[1.8rem] border border-[var(--border-primary)] bg-[var(--surface-secondary)]">
        <PackageTileArt card={card} mode="detail" />
      </div>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
        <main className="grid gap-8">
          <div className="border-b border-[var(--border-primary)]">
            <div className="inline-flex border-b border-[var(--text-primary)] pb-3 text-sm font-semibold">
              About
            </div>
          </div>

          <section className="grid gap-4">
            <Text variant="body-xs" color="muted">
              by {card.creator_label}
            </Text>
            <Text variant="heading-2xl" className="text-[clamp(2rem,4vw,4.4rem)] leading-none tracking-[-0.07em]">
              {card.display_name}
            </Text>
            <Text variant="body-lg" color="muted" leading="relaxed" className="max-w-[760px]">
              {card.summary}
            </Text>
            <div className="flex flex-wrap gap-2">
              <Badge variant="muted-outline" size="lg">
                {card.kind_label}
              </Badge>
              {card.capabilities.map((capability) => (
                <Badge key={capability} variant="neutral" size="lg">
                  {capability}
                </Badge>
              ))}
            </div>
          </section>

          <StatStrip
            stats={[
              { label: 'Category', value: card.kind_label },
              { label: 'Price', value: card.price_label },
              { label: 'Runs on', value: card.execution_label },
              { label: 'By', value: card.creator_label },
            ]}
          />

          <PresentationSectionRenderer sections={card.presentation_sections} />

          <PackageRecordVisibility card={card} />

          <StoreRatingsReviews
            averageScore={0}
            totalCount={0}
            distribution={[]}
            reviews={[]}
          />

          {relatedCards.length > 0 && (
            <section className="grid gap-5 pt-6">
              <GallerySectionHeader
                eyebrow="More like this"
                title="Related packages"
                detail={`${relatedCards.length} packages`}
              />
              <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
                {relatedCards.map((relatedCard) => (
                  <MiniRelatedCard key={relatedCard.row_id} card={relatedCard} />
                ))}
              </div>
            </section>
          )}
        </main>

        <aside className="grid h-fit gap-8 border-t border-[var(--border-primary)] pt-8 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-0">
          <DetailSidebarSection title="Good for">
            <div className="flex flex-wrap gap-2">
              {card.facets.slice(1, 7).map((tag) => (
                <Badge key={tag.id} variant="muted-outline" size="lg">
                  {tag.label}
                </Badge>
              ))}
            </div>
          </DetailSidebarSection>

          <DetailSidebarSection title="Made by">
            <Text variant="body" color="muted">
              {card.creator_label}
            </Text>
          </DetailSidebarSection>

          <DetailSidebarSection title="Next step">
            <InstallActionPanel
              accountSession={accountSession}
              actionCapabilities={actionCapabilities}
              browseConfig={browseConfig}
              card={card}
              installDestinations={installDestinations}
            />
          </DetailSidebarSection>
        </aside>
      </div>
    </div>
  );
}

function InstallActionPanel({
  accountSession,
  actionCapabilities,
  browseConfig,
  card,
  installDestinations: installDestinationsInput,
}: {
  accountSession?: AccountSessionView | null;
  actionCapabilities?: unknown;
  browseConfig: BrowseSurfaceConfig;
  card: CatalogCardView;
  installDestinations?: unknown;
}) {
  const [paymentMaterial, setPaymentMaterial] = React.useState<HostedPaymentMaterial | null>(null);
  const [paymentSubmitState, setPaymentSubmitState] = React.useState<HostedPaymentSubmitState>({
    ready: false,
    submit: null,
    submitting: false,
  });
  const [status, setStatus] = React.useState<
    | { kind: 'idle' }
    | { kind: 'submitting' }
    | { kind: 'checkout-ready'; detail: string }
    | { kind: 'installed'; detail: string; installRef: string }
    | { kind: 'blocked'; detail: string }
  >({ kind: 'idle' });
  const acquisitionAction = card.acquisition_action;
  const installAction = card.install_action;
  const installTarget = installAction
    ? readPreferredActionTarget(
      actionCapabilities,
      'action:store-install',
      [installAction.target],
    )
    : null;
  const installDestinations = React.useMemo(
    () => readInstallDestinationOptions(
      browseConfig.local_package_file_request_defaults,
      installDestinationsInput,
    ),
    [browseConfig.local_package_file_request_defaults, installDestinationsInput],
  );
  const [selectedTargetPackageSet, setSelectedTargetPackageSet] = React.useState(
    () => installDestinations[0]?.package_set ?? '',
  );
  const signedIn = Boolean(accountSession?.accountId);
  const installed = status.kind === 'installed';
  const requiresAccountAccess = Boolean(
    acquisitionAction?.requires_payment ||
    (installAction?.exchange_refs.required_owner_target_refs.length ?? 0) > 0,
  );
  const hasInstallPointers = (installAction?.exchange_refs.package_file_download_pointer_object_keys.length ?? 0) > 0;
  const packageDownloadUrl = installAction
    ? packageDownloadUrlFromInstallAction(installAction, browseConfig.local_package_file_request_defaults)
    : null;
  const hasPackageFile = Boolean(installAction && hasInstallPointers);
  const selectedTargetIsSource = Boolean(
    installAction &&
    selectedTargetPackageSet &&
    sourcePackageSetsFromInstallAction(installAction).has(selectedTargetPackageSet),
  );
  const canInstall = Boolean(
    installAction &&
    installTarget &&
    hasPackageFile &&
    !selectedTargetIsSource &&
    !installed &&
    status.kind !== 'submitting' &&
    (!requiresAccountAccess || signedIn),
  );

  React.useEffect(() => {
    setPaymentMaterial(null);
    setPaymentSubmitState({ ready: false, submit: null, submitting: false });
    setStatus({ kind: 'idle' });
    setSelectedTargetPackageSet(installDestinations[0]?.package_set ?? '');
  }, [
    acquisitionAction?.purchase_option_ref,
    card.identity,
    installDestinations,
    installAction?.target,
  ]);

  async function requestInstall(accessProofRef?: string) {
    if (!installAction) {
      setStatus({ kind: 'blocked', detail: 'This package is missing package files.' });
      return;
    }
    if (!installTarget) {
      setStatus({ kind: 'blocked', detail: 'Package install is not available from this page.' });
      return;
    }
    if (!hasPackageFile) {
      setStatus({ kind: 'blocked', detail: 'This package does not have package files ready to install yet.' });
      return;
    }
    const targetPackageSet = selectedTargetPackageSet.trim();
    if (selectedTargetIsSource) {
      setStatus({
        kind: 'blocked',
        detail: 'Choose a different package set than the one publishing this package.',
      });
      return;
    }
    if (requiresAccountAccess && !signedIn) {
      setStatus({ kind: 'blocked', detail: 'Sign in to install this package.' });
      return;
    }

    setStatus({ kind: 'submitting' });
    try {
      const body = await invokeHostedJson(
        installTarget,
        packageInstallRequest(installAction, browseConfig.local_package_file_request_defaults, {
          accessProofRef,
          packageIdentity: card.identity,
          signedAccountId: accountSession?.accountId,
          targetPackageSet: targetPackageSet || undefined,
        }),
      );
      const installedTarget = readInstalledPackageSet(body);
      const confirmedTarget = installedTarget ?? targetPackageSet;
      if (targetPackageSet && installedTarget && installedTarget !== targetPackageSet) {
        setStatus({
          kind: 'blocked',
          detail: `Bitfield replied for ${displayPackageSetTarget(installedTarget)} instead of ${displayPackageSetTarget(targetPackageSet)}. No install was confirmed.`,
        });
        return;
      }
      const importedPackage = readImportedPackageForRequest(body, card.identity, confirmedTarget);
      if (!importedPackage) {
        setStatus({
          kind: 'blocked',
          detail: `Bitfield did not report ${card.display_name} as installed in ${displayPackageSetTarget(confirmedTarget)}.`,
        });
        return;
      }
      const installRef = typeof body.target_package_set_install_ref === 'string'
        ? body.target_package_set_install_ref
        : typeof body.package_file_approval_ref === 'string'
          ? body.package_file_approval_ref
          : `package-file-install:${card.identity}`;
      setStatus({
        kind: 'installed',
        detail: `${card.display_name} is installed in ${displayPackageSetTarget(confirmedTarget)}.`,
        installRef,
      });
    } catch (error) {
      setStatus({ kind: 'blocked', detail: publicPackageActionError(error) });
    }
  }

  const requestFreeAcquisitionThenInstall = async () => {
    if (!acquisitionAction || !requiresAccountAccess) {
      await requestInstall();
      return;
    }
    if (acquisitionAction.requires_payment) {
      await requestPaidAcquisition();
      return;
    }
    if (!signedIn) {
      setStatus({ kind: 'blocked', detail: 'Sign in to install this package.' });
      return;
    }

    setStatus({ kind: 'submitting' });
    try {
      const startTarget = readActionTarget(actionCapabilities, 'action:package-purchase', 'package-purchase.start');
      if (!startTarget) throw new Error('Package access target is not declared.');
      const body = await invokeHostedJson(
        startTarget,
        {
          ...packagePurchaseRequest(acquisitionAction, {
            packageIdentity: card.identity,
            signedAccountId: accountSession?.accountId ?? card.identity,
          }),
          consent: { billing: true, legal: true },
          packageIdentity: card.identity,
        },
      );
      await requestInstall(packageAccessProofFromCompletion(body));
    } catch (error) {
      setStatus({ kind: 'blocked', detail: publicPackageActionError(error) });
    }
  };

  const requestPaidAcquisition = async () => {
    if (!acquisitionAction) {
      setStatus({ kind: 'blocked', detail: 'This package is missing its checkout setup.' });
      return;
    }
    if (!acquisitionAction.requires_payment) {
      await requestFreeAcquisitionThenInstall();
      return;
    }
    if (!signedIn) {
      setStatus({ kind: 'blocked', detail: 'Sign in to buy this package.' });
      return;
    }

    setStatus({ kind: 'submitting' });
    setPaymentMaterial(null);
    setPaymentSubmitState({ ready: false, submit: null, submitting: false });
    try {
      const prepareTarget = readActionTarget(actionCapabilities, 'action:package-purchase', 'package-purchase.prepare');
      const startTarget = readActionTarget(actionCapabilities, 'action:package-purchase', 'package-purchase.start');
      const completeTarget = readActionTarget(actionCapabilities, 'action:package-purchase', 'package-purchase.complete');
      if (!prepareTarget || !startTarget || !completeTarget) {
        throw new Error('Package purchase prepare/start/complete targets are not declared.');
      }
      const checkoutRequest = packagePurchaseRequest(acquisitionAction, {
        packageIdentity: card.identity,
        signedAccountId: accountSession?.accountId ?? card.identity,
      });
      const checkout = await invokeHostedJson(prepareTarget, checkoutRequest);
      const materialTarget = typeof checkout.paymentMaterialTarget === 'string'
        ? checkout.paymentMaterialTarget.trim()
        : '';
      if (!materialTarget) {
        throw new Error('Payment material target is not declared.');
      }
      setPaymentMaterial({
        checkout,
        checkoutRequest: {
          ...checkoutRequest,
          consent: { billing: true, legal: true },
        },
        completeTarget,
        customer: {},
        materialTarget,
        startTarget,
      });
      setStatus({ kind: 'checkout-ready', detail: 'Checkout is ready. Finish checkout to install.' });
    } catch (error) {
      setStatus({ kind: 'blocked', detail: publicPackageActionError(error) });
    }
  };

  const requestPackage = async () => {
    if (acquisitionAction?.requires_payment) {
      await requestPaidAcquisition();
      return;
    }
    await requestFreeAcquisitionThenInstall();
  };

  const buttonLabel = status.kind === 'submitting'
    ? acquisitionAction?.requires_payment ? 'Opening checkout' : 'Installing package'
    : installed
      ? 'Installed'
      : acquisitionAction?.requires_payment ? 'Continue to checkout' : 'Install package';

  const downloadButton = packageDownloadUrl ? (
    <a
      className="text-sm font-semibold text-[var(--text-secondary)] underline-offset-4 hover:text-[var(--text-primary)] hover:underline"
      download={packageDownloadFilename(card)}
      href={packageDownloadUrl}
      onClick={() => {
        if (status.kind === 'blocked') setStatus({ kind: 'idle' });
      }}
    >
      Download package file instead
    </a>
  ) : null;

  const actionButton = !hasPackageFile ? (
    <Button className="w-full" variant="primary" size="md" disabled type="button">
      Package file unavailable
    </Button>
  ) : !installTarget && packageDownloadUrl ? (
    <a
      className={buttonVariants({ variant: 'primary', size: 'md', radius: 'none' })}
      download={packageDownloadFilename(card)}
      href={packageDownloadUrl}
    >
      Download package file
    </a>
  ) : requiresAccountAccess && !signedIn ? (
    <a className={buttonVariants({ variant: 'primary', size: 'md', radius: 'none' })} href="/?surface=sign-in">
      Sign in
    </a>
  ) : (
    <Button
      className="w-full"
      variant="primary"
      size="md"
      disabled={!canInstall}
      onClick={requestPackage}
      type="button"
    >
      {buttonLabel}
    </Button>
  );

  const handoffMessage = !installTarget && packageDownloadUrl ? (
    <Text variant="body-xs" color="muted">
      Open the package file with Bitfield to choose the destination app.
    </Text>
  ) : null;

  const statusMessage = status.kind === 'installed' ? (
    <div className="grid gap-2 rounded-xl border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] p-4">
      <Text variant="heading" color="success">
        Package installed.
      </Text>
      <Text variant="body-sm" color="muted" leading="relaxed">
        {status.detail}
      </Text>
    </div>
  ) : status.kind === 'blocked' || status.kind === 'checkout-ready' ? (
    <Text variant="body-sm" color="muted">
      {status.detail}
    </Text>
  ) : null;

  return (
    <div className="grid gap-3">
      {installTarget ? (
        <InstallDestinationPicker
          disabled={installed || status.kind === 'submitting'}
          options={installDestinations}
          selectedPackageSet={selectedTargetPackageSet}
          selectedPackageSetIsSource={selectedTargetIsSource}
          onSelect={(packageSet) => {
            setSelectedTargetPackageSet(packageSet);
            if (status.kind === 'blocked') setStatus({ kind: 'idle' });
          }}
        />
      ) : null}
      {actionButton}
      {installTarget ? downloadButton : handoffMessage}
      {paymentMaterial ? (
        <Button
          variant="secondary"
          size="md"
          disabled={!paymentSubmitState.ready || paymentSubmitState.submitting || installed}
          onClick={() => paymentSubmitState.submit?.()}
          type="button"
        >
          {paymentSubmitState.submitting ? 'Finishing checkout' : 'Buy package'}
        </Button>
      ) : null}
      {paymentMaterial ? (
        <HostedPaymentMaterialOutlet
          material={paymentMaterial}
          disabled={installed}
          onComplete={(body) => {
            void requestInstall(packageAccessProofFromCompletion(body));
          }}
          onFailure={(message) => setStatus({ kind: 'blocked', detail: publicPackageActionError(message) })}
          onSubmitStateChange={setPaymentSubmitState}
        />
      ) : null}
      {statusMessage}
    </div>
  );
}

function InstallDestinationPicker({
  disabled,
  options,
  selectedPackageSet,
  selectedPackageSetIsSource,
  onSelect,
}: {
  disabled: boolean;
  options: BrowseInstallDestinationOption[];
  selectedPackageSet: string;
  selectedPackageSetIsSource: boolean;
  onSelect: (packageSet: string) => void;
}) {
  const hasOptions = options.length > 0;
  return (
    <label className="grid gap-2">
      <Text variant="body-xs" color="muted" className="font-semibold">
        Install into
      </Text>
      <select
        className="h-11 w-full border border-[var(--border-primary)] bg-[var(--surface-secondary)] px-3 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled || !hasOptions}
        value={selectedPackageSet}
        onChange={(event) => onSelect(event.currentTarget.value)}
      >
        {hasOptions ? null : <option value="">No install destination declared</option>}
        {options.map((option) => (
          <option key={option.package_set} value={option.package_set}>
            {option.label}
          </option>
        ))}
      </select>
      {selectedPackageSetIsSource ? (
        <Text variant="body-xs" color="muted">
          Choose a different package set than the one publishing this package.
        </Text>
      ) : (
        <Text variant="body-xs" color="muted">
          {options.find((option) => option.package_set === selectedPackageSet)?.detail || 'Package files will be accepted into the selected package set.'}
        </Text>
      )}
    </label>
  );
}

function HostedPaymentMaterialOutlet({
  disabled,
  material,
  onComplete,
  onFailure,
  onSubmitStateChange,
}: {
  disabled: boolean;
  material: HostedPaymentMaterial;
  onComplete: (body: Record<string, unknown>) => void;
  onFailure: (message: string) => void;
  onSubmitStateChange: (state: HostedPaymentSubmitState) => void;
}) {
  const mountRef = React.useRef<HTMLDivElement | null>(null);
  const onCompleteRef = React.useRef(onComplete);
  const onFailureRef = React.useRef(onFailure);
  const onSubmitStateChangeRef = React.useRef(onSubmitStateChange);

  React.useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  React.useEffect(() => {
    onFailureRef.current = onFailure;
  }, [onFailure]);

  React.useEffect(() => {
    onSubmitStateChangeRef.current = onSubmitStateChange;
  }, [onSubmitStateChange]);

  React.useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    let disposed = false;
    let handled = false;
    let retryTimer: number | null = null;

    function requestRender() {
      if (disposed) return;
      window.dispatchEvent(
        new CustomEvent(material.materialTarget, {
          detail: {
            checkout: material.checkout,
            checkoutRequest: material.checkoutRequest,
            completeTarget: material.completeTarget,
            customer: material.customer,
            disabled,
            fail(message: string) {
              if (!disposed) onFailureRef.current(message);
            },
            flat: true,
            handled() {
              handled = true;
            },
            materialTarget: material.materialTarget,
            mount,
            onComplete(body?: Record<string, unknown>) {
              if (!disposed) onCompleteRef.current(body ?? {});
            },
            onSubmitStateChange: onSubmitStateChangeRef.current,
            startTarget: material.startTarget,
          },
        }),
      );
    }

    function requestClear() {
      window.dispatchEvent(
        new CustomEvent(material.materialTarget, { detail: { mount } }),
      );
    }

    requestRender();
    retryTimer = window.setInterval(() => {
      if (handled || disposed) {
        if (retryTimer !== null) window.clearInterval(retryTimer);
        retryTimer = null;
        return;
      }
      requestRender();
    }, 80);

    const missingTimer = window.setTimeout(() => {
      if (retryTimer !== null) window.clearInterval(retryTimer);
      retryTimer = null;
      if (!disposed && !handled) onFailure('Payment material driver is not mounted.');
    }, 1000);

    return () => {
      disposed = true;
      window.clearTimeout(missingTimer);
      if (retryTimer !== null) window.clearInterval(retryTimer);
      onSubmitStateChangeRef.current({ ready: false, submit: null, submitting: false });
      requestClear();
    };
  }, [disabled, material]);

  return (
    <div
      className="min-h-[180px] rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] p-4"
      ref={mountRef}
    />
  );
}

type HostedTransport = {
  invoke(target: string, payload: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
};

async function readPackageStoreAccountSession(
  actionCapabilities: unknown,
): Promise<AccountSessionView | null> {
  const target = readActionTarget(actionCapabilities, 'action:account-session');
  if (!target) return null;

  try {
    const transport = await readHostedTransport();
    const payload = await transport.invoke(target, new Uint8Array());
    const body = readJsonReply(payload);
    const session = body.session;
    if (!isRecord(session) || typeof session.accountId !== 'string') return null;
    return session.accountId.length > 0 ? { accountId: session.accountId } : null;
  } catch {
    return null;
  }
}

function readActionTarget(
  value: unknown,
  actionRef: string,
  targetRef?: string,
): string | null {
  const targets = readActionTargets(value, actionRef);
  return targetRef ? targets.find((target) => target === targetRef) ?? null : targets[0] ?? null;
}

function readPreferredActionTarget(
  value: unknown,
  actionRef: string,
  targetRefs: readonly string[],
): string | null {
  const targets = readActionTargets(value, actionRef);
  for (const targetRef of targetRefs) {
    if (targets.includes(targetRef)) return targetRef;
  }
  return null;
}

function readActionTargets(
  value: unknown,
  actionRef: string,
): string[] {
  if (!isRecord(value) || !Array.isArray(value.action_requirements)) return [];
  for (const item of value.action_requirements) {
    if (!isRecord(item) || item.action_ref !== actionRef || !Array.isArray(item.target_refs)) {
      continue;
    }
    return item.target_refs.filter((candidate): candidate is string => (
      typeof candidate === 'string' && candidate.length > 0
    ));
  }
  return [];
}

function readJsonReply(payload: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(payload);
  const parsed = text.trim() ? JSON.parse(text) : {};
  return isRecord(parsed) ? parsed : {};
}

function purchaseAttemptId(accountId: string, packageIdentity: string) {
  const raw = `package-purchase:${accountId}:${packageIdentity}:${Date.now()}`;
  return raw.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 128);
}

function packagePurchaseRequest(
  action: CatalogAcquisitionActionView,
  input: {
    packageIdentity: string;
    signedAccountId: string;
  },
) {
  const purchaseAttemptIdValue = purchaseAttemptId(
    input.signedAccountId,
    input.packageIdentity,
  );

  return {
    amountDueTodayCents: action.amount_due_today_cents,
    cadence: action.cadence,
    currency: action.currency,
    lineItemLabel: action.line_item_label,
    packageFileRef: action.package_file_ref,
    policyHash: action.policy_refs[0] ?? action.signed_deal_contract_refs[0] ?? action.resource_ref,
    provider_ref: action.provider_ref,
    purchaseAttemptId: purchaseAttemptIdValue,
    purchaseStartedAt: new Date().toISOString(),
    quoteReservationId: action.quote_reservation_id ?? `quote:${input.packageIdentity}:${purchaseAttemptIdValue}`,
    quoteSignature: action.quote_signature,
    recurringAmountCents: action.recurring_amount_cents,
    resourceRef: action.resource_ref,
    settlementAmounts: action.settlement_amounts,
    settlementPolicy: action.settlement_policy,
    shapeRef: action.shape_ref,
    signedDealContractRef: action.signed_deal_contract_refs[0],
  };
}

function packageInstallRequest(
  action: CatalogInstallActionView,
  defaults: BrowseLocalPackageFileRequestDefaults,
  input: {
    accessProofRef?: string;
    packageIdentity: string;
    signedAccountId?: string;
    targetPackageSet?: string;
  },
) {
  const request: Record<string, unknown> = {
    accepted_at: new Date().toISOString(),
    access_proof_refs: uniqueStrings([
      ...action.exchange_refs.access_proof_refs,
      input.accessProofRef ?? '',
    ]),
    admission_fact_refs: action.exchange_refs.admission_fact_refs,
    install_subject: action.subject,
    package_identities: uniqueStrings([
      ...action.package_identities,
      input.packageIdentity,
    ]),
    package_file_download_pointer_object_keys: action.exchange_refs.package_file_download_pointer_object_keys,
    package_use_decision_refs: action.exchange_refs.package_use_decision_refs,
    provenance_refs: action.exchange_refs.provenance_refs,
    publisher_trust_root_refs: action.exchange_refs.publisher_trust_root_refs,
    publisher_trust_roots: action.exchange_refs.publisher_trust_roots,
    request_id: `package-install:${input.packageIdentity}:${Date.now()}`.replace(/[^a-zA-Z0-9:_-]/g, '_').slice(0, 128),
    update_policy_refs: action.exchange_refs.update_policy_refs,
  };
  if (input.targetPackageSet?.trim()) {
    request.target_package_set = input.targetPackageSet.trim();
  }
  const objectStore = localObjectStoreFromConfig(defaults);
  if (objectStore) request.object_store = objectStore;
  if (input.signedAccountId) request.user_id = input.signedAccountId;
  return request;
}

function readInstalledPackageSet(body: Record<string, unknown>): string | null {
  const target = body.target_package_set ?? body.package_set;
  return typeof target === 'string' && target.trim().length > 0 ? target.trim() : null;
}

function readImportedPackage(
  body: Record<string, unknown>,
  packageIdentity: string,
  targetPackageSet: string,
): Record<string, unknown> | null {
  const importedPackages = Array.isArray(body.imported_packages) ? body.imported_packages : [];
  for (const importedPackage of importedPackages) {
    if (!isRecord(importedPackage)) continue;
    if (
      importedPackage.package === packageIdentity &&
      importedPackage.package_set === targetPackageSet
    ) {
      return importedPackage;
    }
  }
  return null;
}

function readImportedPackageForRequest(
  body: Record<string, unknown>,
  packageIdentity: string,
  targetPackageSet: string,
): Record<string, unknown> | null {
  if (targetPackageSet) return readImportedPackage(body, packageIdentity, targetPackageSet);
  const importedPackages = Array.isArray(body.imported_packages) ? body.imported_packages : [];
  for (const importedPackage of importedPackages) {
    if (isRecord(importedPackage) && importedPackage.package === packageIdentity) {
      return importedPackage;
    }
  }
  return null;
}

function readInstallDestinationOptions(
  defaults: BrowseLocalPackageFileRequestDefaults,
  destinationFeed: unknown,
): BrowseInstallDestinationOption[] {
  const liveOptions = readInstallDestinationFeed(destinationFeed);
  if (liveOptions.length > 0) return liveOptions;
  if (defaults.install_destination_options.length > 0) return defaults.install_destination_options;
  if (defaults.target_package_set?.trim()) {
    return [{
      detail: 'Package files will be accepted into this package set.',
      label: displayPackageSetTarget(defaults.target_package_set),
      package_set: defaults.target_package_set.trim(),
    }];
  }
  return [{
    detail: 'The local Bitfield owner will use the active app package set.',
    label: 'Active local Bitfield app',
    package_set: '',
  }];
}

function readInstallDestinationFeed(value: unknown): BrowseInstallDestinationOption[] {
  if (Array.isArray(value)) return normalizeInstallDestinationOptions(value);
  if (!isRecord(value)) return [];
  if (Array.isArray(value.install_destination_options)) {
    return normalizeInstallDestinationOptions(value.install_destination_options);
  }
  if (Array.isArray(value.destinations)) {
    return normalizeInstallDestinationOptions(value.destinations);
  }
  if (Array.isArray(value.package_sets)) {
    return normalizeInstallDestinationOptions(value.package_sets);
  }
  return [];
}

function normalizeInstallDestinationOptions(value: unknown[]): BrowseInstallDestinationOption[] {
  const byPackageSet = new Map<string, BrowseInstallDestinationOption>();
  for (const item of value) {
    const option = readInstallDestinationOption(item);
    if (!option) continue;
    byPackageSet.set(option.package_set, option);
  }
  return [...byPackageSet.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function readInstallDestinationOption(value: unknown): BrowseInstallDestinationOption | null {
  if (typeof value === 'string' && value.trim()) {
    const packageSet = value.trim();
    return {
      detail: 'Package files will be accepted into this package set.',
      label: displayPackageSetTarget(packageSet),
      package_set: packageSet,
    };
  }
  if (!isRecord(value)) return null;
  const packageSet = textFromUnknown(
    value.package_set ?? value.packageSet ?? value.package_set_id ?? value.id ?? value.app_id,
  );
  if (!packageSet) return null;
  return {
    detail: textFromUnknown(value.detail ?? value.description) || 'Package files will be accepted into this package set.',
    label: textFromUnknown(value.label ?? value.app_name ?? value.name) || displayPackageSetTarget(packageSet),
    package_set: packageSet,
  };
}

function textFromUnknown(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function sourcePackageSetsFromInstallAction(action: CatalogInstallActionView): Set<string> {
  const sourcePackageSets = new Set<string>();
  for (const objectKey of action.exchange_refs.package_file_download_pointer_object_keys) {
    const match = objectKey.match(/^package-sets\/([^/]+)\/package-files\//u);
    if (match?.[1]) sourcePackageSets.add(match[1]);
  }
  for (const trustRoot of action.exchange_refs.publisher_trust_roots) {
    const scope = isRecord(trustRoot.scope) ? trustRoot.scope : null;
    const packageSets = Array.isArray(scope?.package_sets) ? scope.package_sets : [];
    for (const packageSet of packageSets) {
      if (typeof packageSet === 'string' && packageSet.trim()) {
        sourcePackageSets.add(packageSet.trim());
      }
    }
  }
  return sourcePackageSets;
}

function displayPackageSetTarget(target: string | null): string {
  if (!target) return 'the selected package set';
  return target
    .split(/[-_\s]+/gu)
    .filter(Boolean)
    .map((part) => part.toLowerCase() === 'bitfield'
      ? 'Bitfield'
      : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function packageDownloadUrlFromInstallAction(
  action: CatalogInstallActionView,
  defaults: BrowseLocalPackageFileRequestDefaults,
): string | null {
  const objectKey = action.exchange_refs.package_file_download_pointer_object_keys
    .find((key) => key.trim().length > 0)
    ?.trim();
  if (!objectKey) return null;

  try {
    const objectStore = localObjectStoreFromConfig(defaults);
    const settings = isRecord(objectStore?.settings) ? objectStore.settings : null;
    const baseUrl = typeof settings?.base_url === 'string' ? settings.base_url.trim() : '';
    if (!baseUrl) return null;
    const normalizedBaseUrl = baseUrl.replace(/\/+$/u, '');
    // The carrier's byte-address object store serves objects at their LOGICAL
    // key path (e.g. package-sets/<set>/package-files/latest.json), not the
    // hex-encoded copy-file transport name (objects-named-by-hex-encoded-object-key-text/<hex>).
    // Encode each path segment but preserve the "/" separators.
    const encodedObjectPath = objectKey
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return `${normalizedBaseUrl}/${encodedObjectPath}`;
  } catch {
    return null;
  }
}

function packageDownloadFilename(card: CatalogCardView): string {
  return `${card.identity.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'bitfield-package'}.bitfield-package`;
}

function localObjectStoreFromConfig(
  defaults: BrowseLocalPackageFileRequestDefaults,
): Record<string, unknown> | undefined {
  const method = defaults.object_store_method.trim();
  if (!method) return undefined;
  const settingsText = defaults.object_store_settings_json.trim();
  return {
    method,
    settings: settingsText ? JSON.parse(settingsText) : {},
  };
}

function packageAccessProofFromCompletion(body: Record<string, unknown>) {
  const proofRef = body.packageAccessProofRef;
  return typeof proofRef === 'string' && proofRef.trim().length > 0
    ? proofRef.trim()
    : 'package-access-proof:checkout-complete';
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function invokeHostedJson(target: string, payload: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);

  try {
    const transport = await readHostedTransport();
    return readJsonReply(await transport.invoke(
      target,
      new TextEncoder().encode(JSON.stringify(payload)),
      controller.signal,
    ));
  } finally {
    window.clearTimeout(timeout);
  }
}

function publicPackageActionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/BITFIELD_LOCAL_TARGET_CARRIER_UNREACHABLE/i.test(message)) {
    return 'Open Bitfield on this computer, then press Install package again. This website cannot install package files until the local Bitfield app is reachable.';
  }
  if (/Bitfield target carrier failed/i.test(message)) {
    return 'Bitfield is open, but its local install target failed. Try again after Bitfield finishes starting.';
  }
  if (/BRTK8012_PACKAGE_FILE_INSTALL_TARGET_NOT_SELECTED_OWNER/i.test(message)) {
    return 'This hosted Package Store cannot write into another Bitfield app. Download the package file and open it with Bitfield.';
  }
  if (/abort|timeout/i.test(message)) {
    return 'Package Store did not finish the request. Try again.';
  }
  return 'Package Store could not finish that request. Try again.';
}

async function readHostedTransport(): Promise<HostedTransport> {
  const hooks = (globalThis as {
    __BITFIELD_BOOT_HOOKS__?: {
      connect?: () => Promise<{ transport?: HostedTransport }> | { transport?: HostedTransport };
    };
  }).__BITFIELD_BOOT_HOOKS__;

  if (!hooks?.connect) {
    throw new Error('Hosted action carrier is not available on this page.');
  }

  const connection = await hooks.connect();
  if (!connection.transport) {
    throw new Error('Hosted action carrier did not return a transport.');
  }

  return connection.transport;
}

function DetailSidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <Text variant="heading-xs" color="muted">
        {title}
      </Text>
      {children}
    </section>
  );
}

function MiniRelatedCard({ card }: { card: CatalogCardView }) {
  return (
    <article className="grid gap-2">
      <div className="overflow-hidden rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-primary)]">
        <PackageTileArt card={card} mode="mini" />
      </div>
      <Text variant="heading" truncate>
        {card.display_name}
      </Text>
      <Text variant="body-xs" color="muted" truncate>
        by {card.creator_label} • {card.price_label}
      </Text>
    </article>
  );
}

function readStorefrontFilters(
  filters: CatalogFilter[],
  browseConfig: BrowseSurfaceConfig,
  activeFilter: string,
): CatalogFilter[] {
  const storefrontGroups = new Set(browseConfig.storefront_filter_groups);
  const publicFilters = filters.filter((filter) => (
    filter.id === 'all' ||
    storefrontGroups.has(filter.group)
  ));
  const activeVisible = publicFilters.some((filter) => filter.id === activeFilter);
  const activeFilterEntry = filters.find((filter) => filter.id === activeFilter);

  if (activeFilterEntry && !activeVisible) {
    return [...publicFilters, activeFilterEntry];
  }

  return publicFilters;
}

function readRelatedCards(cards: CatalogCardView[], selectedCard: CatalogCardView) {
  const selectedFilters = new Set(selectedCard.filter_ids);
  return cards
    .filter((card) => card.row_id !== selectedCard.row_id)
    .map((card) => ({
      card,
      score: card.filter_ids.filter((filter) => selectedFilters.has(filter)).length,
    }))
    .sort((left, right) => right.score - left.score || left.card.display_name.localeCompare(right.card.display_name))
    .slice(0, 3)
    .map((entry) => entry.card);
}

function FilterRail({
  activeFilter,
  filters,
  onChange,
}: {
  activeFilter: string;
  filters: { id: string; label: string; count: number }[];
  onChange: (filter: string) => void;
}) {
  return (
    <div className="mx-auto flex max-w-full justify-start gap-2 overflow-x-auto px-1 pb-1 sm:justify-center">
      {filters.map((filter) => (
        <Button
          key={filter.id}
          type="button"
          variant="ghost"
          size="sm"
          active={activeFilter === filter.id}
          onClick={() => onChange(filter.id)}
          className="shrink-0 whitespace-nowrap rounded-full"
        >
          {filter.label}
          <Badge variant="neutral" size="sm" tabIndex={-1}>
            {filter.count}
          </Badge>
        </Button>
      ))}
    </div>
  );
}

function PackageTileArt({
  card,
  mode,
}: {
  card: CatalogCardView;
  mode: 'gallery' | 'detail' | 'mini';
}) {
  return (
    <div
      className="package-store-package-art-frame"
      aria-hidden="true"
      data-visual-key={card.visual_key}
      style={readPackageTileArtFrameStyle(mode)}
    >
      {isPointillistPreviewArt(card.preview_art) ? (
        <PointillistPackagePreviewCanvas
          frameUrl={card.preview_art.data_url}
          className="package-store-package-art-canvas"
        />
      ) : card.preview_art?.data_url ? (
        <img
          alt=""
          decoding="async"
          loading={mode === 'gallery' ? 'lazy' : 'eager'}
          src={card.preview_art.data_url}
          style={PACKAGE_TILE_ART_IMAGE_STYLE}
        />
      ) : (
        <div
          className="grid place-items-center px-6 text-center"
          style={PACKAGE_TILE_ART_EMPTY_STYLE}
        >
          <Text variant="body" color="muted">
            Preview image missing.
          </Text>
        </div>
      )}
    </div>
  );
}

const PACKAGE_TILE_ART_IMAGE_STYLE: React.CSSProperties = {
  display: 'block',
  height: '100%',
  objectFit: 'cover',
  width: '100%',
};

const PACKAGE_TILE_ART_EMPTY_STYLE: React.CSSProperties = {
  background: 'var(--glass-bg-primary)',
  height: '100%',
  width: '100%',
};

function readPackageTileArtFrameStyle(mode: 'gallery' | 'detail' | 'mini'): React.CSSProperties {
  return {
    aspectRatio: '16 / 9',
    background: 'color-mix(in srgb, var(--surface-base) 54%, var(--text-primary) 46%)',
    maxHeight: mode === 'detail' ? 'min(56svh, 580px)' : undefined,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  };
}

function PackageFindingDetail({
  block,
}: {
  block: CatalogCardView['detail_blocks'][number];
}) {
  return (
    <section className="grid gap-3">
      <Text variant="heading-lg">{block.title}</Text>
      {block.body ? (
        <Text variant="body-lg" color="muted" leading="relaxed" className="max-w-[760px]">
          {block.body}
        </Text>
      ) : null}
      {block.items && block.items.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {block.items.map((item) => (
            <div
              key={item}
              className="rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] px-4 py-3"
            >
              <Text variant="body-xs" color="muted">
                {item}
              </Text>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function isPointillistPreviewArt(
  preview: CatalogCardView['preview_art'],
): preview is NonNullable<CatalogCardView['preview_art']> & { data_url: string } {
  return Boolean(
    preview?.data_url &&
      preview.media_type === 'application/vnd.bitfield.pointillist-target-animation+gzip',
  );
}

type RecordVisibilityLeaf = {
  key: string;
  value: string;
};

type RecordVisibilityGroup = {
  id: string;
  title: string;
  refs: string[];
  rows: RecordVisibilityLeaf[];
};

function PackageRecordVisibility({ card }: { card: CatalogCardView }) {
  const groups = readRecordVisibilityGroups(card);
  if (groups.length === 0) return null;

  return (
    <details className="rounded-xl border border-[var(--border-primary)] bg-[var(--glass-bg-primary)] p-4">
      <summary className="cursor-pointer text-sm font-semibold text-[var(--text-secondary)]">
        Developer details
      </summary>
      <div className="mt-4 grid gap-4">
        <Text variant="body-xs" color="muted">
          Raw package rows are shown here for creators and reviewers. The Store still forwards these values to their owners instead of deciding account, payment, fee, meter, or package-file approval locally.
        </Text>
        <div className="grid gap-3 lg:grid-cols-2">
          {groups.map((group) => (
            <div
              key={group.id}
              className="min-w-0 rounded-lg border border-[var(--border-primary)] bg-[var(--surface-primary)] p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <Text variant="heading-xs" color="muted">
                  {group.title}
                </Text>
                <Badge variant="muted-outline" size="sm" tabIndex={-1}>
                  {group.refs.length + group.rows.length}
                </Badge>
              </div>
              <div className="mt-3 grid gap-2">
                {group.refs.map((ref) => (
                  <Text key={ref} variant="caption" color="muted" mono wrap="preserve">
                    {ref}
                  </Text>
                ))}
                {group.rows.map((row) => (
                  <div
                    key={`${row.key}:${row.value}`}
                    className="grid min-w-0 gap-1 border-t border-[var(--border-primary)] pt-2 first:border-t-0 first:pt-0"
                  >
                    <Text variant="caption" color="faint" mono wrap="preserve">
                      {row.key}
                    </Text>
                    <Text variant="caption" color="muted" mono wrap="preserve">
                      {row.value}
                    </Text>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function LogoMark({ competitor }: { competitor: CatalogReplacementSearchResult['composition']['competitors'][number] }) {
  const [assetFailed, setAssetFailed] = React.useState(false);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-primary)] bg-[var(--surface-base)] px-2 py-1"
      title={competitor.comparison_disclaimer}
    >
      {!assetFailed && competitor.logo_url ? (
        <img
          alt=""
          className="h-4 w-4 object-contain"
          src={competitor.logo_url}
          onError={() => setAssetFailed(true)}
        />
      ) : null}
      <span className="text-xs font-medium">{competitor.name}</span>
    </span>
  );
}

function readRecordVisibilityGroups(card: CatalogCardView): RecordVisibilityGroup[] {
  const action = card.install_action;
  const acquisition = card.acquisition_action;
  const groups: RecordVisibilityGroup[] = [
    {
      id: 'access',
      title: 'Access records',
      refs: uniqueStrings([
        ...(action?.exchange_refs.admission_fact_refs ?? []),
        ...(action?.exchange_refs.access_proof_refs ?? []),
      ]),
      rows: [],
    },
    {
      id: 'deal',
      title: 'Deal and quote records',
      refs: uniqueStrings([
        ...(acquisition?.signed_deal_contract_refs ?? []),
        ...(acquisition?.quote_reservation_refs ?? []),
        acquisition?.quote_reservation_id,
        acquisition?.quote_signature,
        acquisition?.purchase_option_ref,
        acquisition?.provider_ref,
        acquisition?.resource_ref,
        acquisition?.package_file_ref,
        acquisition?.shape_ref,
        ...(acquisition?.policy_refs ?? []),
      ].filter(isNonEmptyString)),
      rows: [],
    },
    {
      id: 'meter',
      title: 'Meter records',
      refs: uniqueStrings(acquisition?.meter_unit_refs ?? []),
      rows: [],
    },
    {
      id: 'settlement-rule',
      title: 'Settlement rule data',
      refs: [],
      rows: flattenRecordLeaves(acquisition?.settlement_policy),
    },
    {
      id: 'settlement-amounts',
      title: 'Settlement amount data',
      refs: [],
      rows: flattenRecordLeaves(acquisition?.settlement_amounts),
    },
    {
      id: 'package-files',
      title: 'Package-file and listing records',
      refs: uniqueStrings([
        ...(action?.exchange_refs.package_file_download_pointer_object_keys ?? []),
        ...(action?.exchange_refs.package_file_metadata_pointer_refs ?? []),
        ...(action?.exchange_refs.package_use_decision_refs ?? []),
        ...(action?.exchange_refs.update_policy_refs ?? []),
        ...(action?.exchange_refs.provenance_refs ?? []),
      ]),
      rows: [],
    },
  ];

  return groups.filter((group) => group.refs.length > 0 || group.rows.length > 0);
}

function flattenRecordLeaves(value: unknown, path: string[] = []): RecordVisibilityLeaf[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => flattenRecordLeaves(child, [...path, String(index)]));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => (
      flattenRecordLeaves(child, [...path, key])
    ));
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [{ key: path.join('.') || 'value', value: String(value) }];
  }
  return [];
}

function CatalogSkeleton() {
  return (
    <div className="grid gap-x-10 gap-y-16 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading package catalog">
      {Array.from({ length: 6 }).map((_, index) => (
        <article key={index} className="grid gap-3">
          <div className="aspect-[16/9] animate-pulse rounded-xl bg-[var(--glass-bg-primary)]" />
          <div className="h-5 w-2/3 rounded bg-[var(--glass-bg-primary)]" />
          <div className="h-4 w-1/2 rounded bg-[var(--glass-bg-primary)]" />
        </article>
      ))}
    </div>
  );
}

function readCardSignals(card: CatalogCardView, index: number) {
  return {
    records: formatCompact(Math.max(card.ref_count, 1) * 100 + index * 37),
    capabilities: formatCompact(Math.max(card.capabilities.length, 1) * 1000 + card.ref_count * 13),
  };
}

function formatCompact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}
