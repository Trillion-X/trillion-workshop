#!/usr/bin/env node
/**
 * Transform script: Add discovery metadata (package_finding) to collection rows
 * in the catalog that lack it.
 *
 * This bridges between the static collection rows added by C1 and the discovery
 * system that requires package_finding metadata with shelf_ids and facets.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const catalogPath = path.resolve(process.argv[2] ?? 'packages/bitfield-package-store-catalog/data/catalog.json');
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

if (!catalog.catalog_rows) {
  console.error('No catalog_rows found in catalog');
  process.exit(1);
}

// Transform collection rows to add package_finding metadata
let transformedCount = 0;
for (const row of catalog.catalog_rows) {
  if (row.row_kind === 'collection-row' && !row.package_finding) {
    row.package_finding = createPackageFinding(row);
    transformedCount++;
  }
}

console.log(`Added package_finding to ${transformedCount} collection rows`);
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

function createPackageFinding(row) {
  const capabilities = row.capability_metadata?.public_capability_summary ?? [];
  const searchCorpus = [
    row.display_name,
    row.summary,
    'collection',
    'collection-row',
    ...capabilities,
  ];

  return {
    schema: 'bitfield.package_store.package_finding.v1',
    row_id: row.row_id,
    title: row.display_name,
    summary: row.summary,
    blocks: [],
    categories: [],
    capabilities,
    facets: [
      { id: 'all', label: 'All', group: 'all' },
      { id: 'collection-row', label: 'Collections', group: 'kind' },
      { id: 'access:public', label: 'Public', group: 'access' },
    ],
    shelf_ids: ['collections', 'featured'],
    search: {
      aliases: [
        row.display_name,
        'collection',
        ...capabilities,
      ],
      text: searchCorpus.join(' ').toLowerCase(),
    },
    ranking: {
      score: 45,
      signals: [
        { id: 'has-preview', label: 'No preview image yet', group: 'quality' },
        { id: 'kind:collection-row', label: 'Collections', group: 'kind' },
        { id: 'access:public', label: 'Public', group: 'access' },
      ],
      result_explanations: [
        'Collections / Public',
      ],
    },
    detail_blocks: [
      {
        id: 'what-it-does',
        title: 'What it does',
        body: row.summary,
      },
      {
        id: 'best-for',
        title: 'Best for',
        items: capabilities,
      },
      {
        id: 'before-install',
        title: 'Before you install',
        items: ['Code visible', 'Runs locally', 'Public'],
      },
    ],
  };
}
