// tools/evaluate-progress/read-data/get-path.ts
// Read the value at a path ARRAY inside an object; an empty path gives the object itself, a missing segment gives undefined. Pure, total.


export function getPath(obj: unknown, path: readonly string[] | undefined): unknown {
  if (!path || path.length === 0) return obj;
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
