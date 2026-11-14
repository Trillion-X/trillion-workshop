import { readBrowseSurfaceConfig, readCatalogView } from './read-catalog-view';

export function readJscorePackageStoreView({
  catalog,
  browseConfig,
}: {
  catalog?: unknown;
  browseConfig?: unknown;
}) {
  const config = readBrowseSurfaceConfig(browseConfig);
  const view = readCatalogView(catalog, config);
  return {
    schema: 'generic.record_action_projection.jscore_package_store_view',
    state: view.cards.length === 0 ? 'empty' : 'ready',
    heading: view.heading,
    deck: view.deck,
    cards: view.cards.map((card) => ({
      record_ref: card.row_id,
      primary_text: card.display_name,
      secondary_text: card.summary,
      action_count: card.install_action ? 1 : 0,
      block_count: card.detail_blocks.length,
      relationship_count: card.ref_count,
      search_text: card.search_text,
    })),
    discovery: {
      category_rails: view.discovery.category_rails,
      shelves: view.discovery.shelves,
      replacement_catalog: {
        schema: view.discovery.replacement_catalog.schema,
        comparison_policy: view.discovery.replacement_catalog.comparison_policy,
        competitors: view.discovery.replacement_catalog.competitors,
        request_to_build: view.discovery.replacement_catalog.request_to_build,
        compositions: view.discovery.replacement_catalog.compositions.map((composition) => ({
        id: composition.id,
        label: composition.label,
        founder_problem: composition.founder_problem,
        supported_job: composition.supported_job,
        claim: composition.claim,
        comparison: composition.comparison,
        integration_requirements: composition.integration_requirements,
        economics: composition.economics,
        gaps: composition.gaps,
        search_terms: composition.search_terms,
        migration_path: composition.migration_path,
        proof_cards: composition.proof_cards.map(({ package_identity, role, card }) => ({
          package_identity,
          role,
          record_ref: card.row_id,
          primary_text: card.display_name,
          secondary_text: card.summary,
        })),
        missing_package_identities: composition.missing_package_identities,
        cta: composition.cta,
        request_to_build: composition.request_to_build,
      })),
      },
      recovery_suggestions: view.discovery.recovery_suggestions,
    },
    filters: view.filters,
    stats: view.stats,
  };
}
