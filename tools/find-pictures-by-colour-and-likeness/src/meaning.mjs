// src/meaning.mjs
//
// PURPOSE
//   How close two embeddings are in meaning: the one comparison every meaning search in Trillion uses (the pool's
//   decisions and tools, the network's people and pursuits, the scorer's candidates). Pure, so a Durable Object and a
//   test both import it without the Workers runtime.
//
// NON-NEGOTIABLE INVARIANTS
//   1. 1 means the same direction, 0 unrelated; both vectors have the same length (one embedding model).
//
export const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
};
