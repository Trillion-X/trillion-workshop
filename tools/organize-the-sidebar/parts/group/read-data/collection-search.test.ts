// packages/group/read-data/collection-search.test.ts

import { describe, it, expect } from "../../../../../test-helpers/vitest-shim.mjs";
import {
  searchCollections,
  type SearchableCollection,
  type SearchQuery,
} from "../../../read-data/collection-search.ts";

function entry(
  id: string,
  overrides: Partial<SearchableCollection> = {},
): SearchableCollection {
  return { id, name: id, ...overrides };
}

describe("searchCollections", () => {
  it("(1) a token in name outranks the same token only in description", () => {
    const entries = [
      entry("desc-only", { name: "Alpha Set", description: "onboarding checklist" }),
      entry("name-hit", { name: "Onboarding Kit", description: "misc" }),
    ];
    const result = searchCollections(entries, { text: "onboarding" });

    // name-hit: +3 (name). desc-only: +1 (description). Both kept, name-hit first.
    expect(result).toEqual([
      { id: "name-hit", score: 3 },
      { id: "desc-only", score: 1 },
    ]);
  });

  it("(2) tag filter removes non-tagged entries", () => {
    const entries = [
      entry("tagged", { tags: ["marketing", "launch"] }),
      entry("untagged", { tags: ["sales"] }),
      entry("no-tags", {}),
    ];
    const result = searchCollections(entries, { facets: { tag: ["launch"] } });

    // Only "tagged" carries the tag. No text -> score 0, kept.
    expect(result).toEqual([{ id: "tagged", score: 0 }]);
  });

  it("(2b) tag filter is case-insensitive and exact (no substring)", () => {
    const entries = [
      entry("exact", { tags: ["Launch"] }),
      entry("substr", { tags: ["launchpad"] }), // must NOT match exact "launch"
    ];
    const result = searchCollections(entries, { facets: { tag: ["launch"] } });
    expect(result).toEqual([{ id: "exact", score: 0 }]);
  });

  it("(3) category filter keeps only the matching category (case-insensitive)", () => {
    const entries = [
      entry("a", { category: "Templates" }),
      entry("b", { category: "Boards" }),
      entry("c", { category: "templates" }),
    ];
    const result = searchCollections(entries, { facets: { category: ["templates"] } });

    expect(result).toEqual([
      { id: "a", score: 0 },
      { id: "c", score: 0 },
    ]);
  });

  it("(4) tag + category + text combine: filter first, then rank", () => {
    const entries = [
      // survives both filters, name hit
      entry("keep", {
        name: "Growth Playbook",
        category: "Templates",
        tags: ["growth", "featured"],
        description: "growth loops",
      }),
      // right tag+category but no text hit -> excluded (text present, score 0)
      entry("no-text", {
        name: "Static Kit",
        category: "Templates",
        tags: ["featured"],
        description: "unrelated",
      }),
      // wrong category -> filtered out
      entry("wrong-cat", {
        name: "Growth Growth Growth",
        category: "Boards",
        tags: ["featured"],
      }),
      // wrong tag -> filtered out
      entry("wrong-tag", {
        name: "Growth",
        category: "Templates",
        tags: ["other"],
      }),
    ];
    const query: SearchQuery = { facets: { tag: ["featured"], category: ["templates"] }, text: "growth" };
    const result = searchCollections(entries, query);

    // keep: name +3, tag "growth" includes "growth" +2, description +1 = 6
    expect(result).toEqual([{ id: "keep", score: 6 }]);
  });

  it("(5) empty text keeps all filtered entries in input order with score 0", () => {
    const entries = [entry("x"), entry("y"), entry("z")];

    expect(searchCollections(entries, {})).toEqual([
      { id: "x", score: 0 },
      { id: "y", score: 0 },
      { id: "z", score: 0 },
    ]);
    // whitespace-only text is treated as empty
    expect(searchCollections(entries, { text: "   " })).toEqual([
      { id: "x", score: 0 },
      { id: "y", score: 0 },
      { id: "z", score: 0 },
    ]);
  });

  it("(6) text with no matches excludes those entries (all miss -> [])", () => {
    const entries = [
      entry("a", { name: "Alpha", description: "one" }),
      entry("b", { name: "Beta", tags: ["two"] }),
    ];
    expect(searchCollections(entries, { text: "zzz nonexistent" })).toEqual([]);

    // multi-token: only tokens that hit contribute; a fully-missing entry is dropped.
    const mixed = [
      entry("hit", { name: "Alpha Beta" }),
      entry("miss", { name: "Gamma" }),
    ];
    // "alpha" hits name (+3) on hit; "gamma" hits name (+3) on miss.
    expect(searchCollections(mixed, { text: "alpha delta" })).toEqual([
      { id: "hit", score: 3 },
    ]);
  });

  it("(7) equal scores preserve original input order (stable tie-break)", () => {
    const entries = [
      entry("first", { name: "Report Weekly" }),
      entry("second", { name: "Report Monthly" }),
      entry("third", { name: "Report Daily" }),
    ];
    // each matches "report" in name -> score 3, tie broken by input order.
    expect(searchCollections(entries, { text: "report" })).toEqual([
      { id: "first", score: 3 },
      { id: "second", score: 3 },
      { id: "third", score: 3 },
    ]);
  });

  it("(8) empty entries -> []", () => {
    expect(searchCollections([], { text: "anything" })).toEqual([]);
    expect(searchCollections([], {})).toEqual([]);
  });

  it("(red-team cont.98 batch-40) a malformed entry with a non-string name never crashes .toLowerCase()", () => {
    // An imported collection is UNTRUSTED DATA — `name` may violate its declared string type.
    const entries = [
      { id: "ok", name: "Real Board" },
      { id: "bad1", name: undefined },
      { id: "bad2", name: 42 },
      { id: "bad3", name: null },
    ] as unknown as SearchableCollection[];
    // no throw, and the valid entry still matches by text
    const q: SearchQuery = { text: "real" };
    expect(() => searchCollections(entries, q)).not.toThrow();
    expect(searchCollections(entries, q).map((r) => r.id)).toEqual(["ok"]);
    // with no text, all survive (none crash on coercion)
    expect(searchCollections(entries, {}).length).toBe(4);
  });
});
