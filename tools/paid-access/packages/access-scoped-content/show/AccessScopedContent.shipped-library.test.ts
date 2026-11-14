// packages/access-scoped-content/show/AccessScopedContent.shipped-library.test.ts
//
// THE ROWS A LEARNER ACTUALLY HAS, NOT ROWS A TEST INVENTED.
//
// Every test beside this one hands these owners a tree written by hand, so they
// all agreed the nesting worked while the live rail kept drawing four flat rows
// with play buttons. Two separate reasons, neither visible to a hand-written
// fixture: the shipped rows might not carry the field the tree is read from at
// all, and the shipped rows might be shaped in a way that makes one of these
// owners throw or spin. A bundle built from passing tests was pushed to the live
// app on that confidence and it hung, and the hang was never diagnosed, only
// reverted, which left the defect intact and unnamed.
//
// So this reads the record set the app is actually served, at the address the
// app actually reads, and pushes it through the same two owners the surface
// composes. It fails if the shipped rows lose their depth, if either owner
// refuses them, and — with a timeout — if either owner fails to terminate.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readSurfaceCollections } from '../../../../organize-the-sidebar/read-data/read-surface-collections';
import {
  buildProjectedCollectionsNav,
  projectedCollectionsToCatalogItems,
} from '../../../../organize-the-sidebar/show/ProjectedCollectionNav';
import { containmentCollections } from '../../../../shared-code/packages/access-scoped-content/show/AccessScopedContent';

const PROJECTION_ADDRESS = 'package-set-records::access-scoped-content-projection';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Every package set that ships a library, found by what it declares rather than
 * by a list kept here. A new app with a library is covered the day it is added;
 * a list in this file would cover it the day someone remembered. */
function shippedLibraries(): { setName: string; rows: Record<string, unknown>[] }[] {
  const setsFolder = path.join(repositoryRoot, 'package-sets');
  const found: { setName: string; rows: Record<string, unknown>[] }[] = [];
  for (const setName of readdirSorted(setsFolder)) {
    const recordsFolder = path.join(setsFolder, setName, 'package-set-records');
    for (const fileName of readdirSorted(recordsFolder)) {
      if (!fileName.endsWith('.json')) continue;
      const parsed = JSON.parse(readFileSync(path.join(recordsFolder, fileName), 'utf8'));
      const records = Array.isArray(parsed) ? parsed : parsed?.records;
      if (!Array.isArray(records)) continue;
      for (const record of records) {
        if (record?.address !== PROJECTION_ADDRESS) continue;
        if (!Array.isArray(record.payload) || record.payload.length === 0) continue;
        found.push({ setName, rows: record.payload });
      }
    }
  }
  return found;
}

function readdirSorted(folder: string): string[] {
  try {
    return readdirSync(folder).sort();
  } catch {
    return [];
  }
}

function deepestLevel(
  collections: readonly { collections?: readonly unknown[] }[],
  level = 1,
): number {
  let deepest = collections.length > 0 ? level : 0;
  for (const collection of collections) {
    const children = (collection.collections ?? []) as readonly { collections?: readonly unknown[] }[];
    deepest = Math.max(deepest, deepestLevel(children, level + 1));
  }
  return deepest;
}

function countRows(
  collections: readonly { items: readonly unknown[]; collections?: readonly unknown[] }[],
): number {
  return collections.reduce(
    (total, collection) => total + collection.items.length + countRows((collection.collections ?? []) as never),
    0,
  );
}

const libraries = shippedLibraries();

describe('the library rows this repository actually ships', () => {
  it('finds at least one shipped library, so an empty sweep cannot pass as a green suite', () => {
    expect(libraries.length).toBeGreaterThan(0);
  });

  for (const { setName, rows } of libraries) {
    describe(setName, () => {
      // A generous ceiling: these owners are pure and run in milliseconds over
      // a hundred rows. A run that reaches this bound is not slow, it is the
      // non-termination that took the live surface down.
      it('projects into a tree deeper than one level and terminates', { timeout: 5000 }, () => {
        const collections = containmentCollections(rows as never, 'Library', null);
        expect(countRows(collections)).toBeGreaterThan(0);
        expect(deepestLevel(collections)).toBeGreaterThan(1);
      });

      it('survives the sidebar projection and keeps every level after decoding', { timeout: 5000 }, () => {
        const collections = containmentCollections(rows as never, 'Library', null);
        const decoded = readSurfaceCollections(buildProjectedCollectionsNav({
          scope: 'access-scoped-content-lessons',
          collections,
        }));
        expect(decoded.length).toBeGreaterThan(0);
        // Nothing the projection accepted may vanish in the decode: a row a
        // learner can see but not reach is the failure this whole change exists
        // to remove.
        const catalog = projectedCollectionsToCatalogItems(collections);
        expect(catalog.length).toBe(countRows(collections));
      });

      it('opens every row it draws, at every depth', { timeout: 5000 }, () => {
        const collections = containmentCollections(rows as never, 'Library', null);
        const catalogIds = new Set(projectedCollectionsToCatalogItems(collections).map((item) => item.id));
        const drawn: string[] = [];
        const walk = (list: readonly { items: readonly { id: string }[]; collections?: readonly unknown[] }[]) => {
          for (const collection of list) {
            for (const item of collection.items) drawn.push(item.id);
            walk((collection.collections ?? []) as never);
          }
        };
        walk(collections as never);
        expect(drawn.length).toBeGreaterThan(0);
        expect(drawn.filter((id) => !catalogIds.has(id))).toEqual([]);
      });
    });
  }
});
