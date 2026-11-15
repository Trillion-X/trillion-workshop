// src/search-vector-index.mjs
//
// Purpose: the nearest-bucket index over a meaning lane's kept vectors (src/search.mjs search_vectors), so a meaning
// search reads the vectors near its question, never every vector kept. Each lane past `min_vectors` learns centroids
// (k-means over a bounded sample) as idle work; every vector carries the bucket of its nearest centroid; a question
// reads the `probe` buckets whose centroids are nearest it, plus any vectors not given a bucket yet.
//
// Non-Negotiable Invariants:
//   1. A search never trains or assigns: learning centroids and giving vectors their buckets is step(), idle work on
//      the store's alarm, one bounded piece per call (a sample for training, `assign_page` vectors for assigning).
//   2. A vector with no bucket (kept before the lane was trained, or since it was trained again) is still read by
//      every search, so the index never hides what was kept; it only stops reading the far buckets.
//   3. A lane under `min_vectors` has no index and is read whole: a small lane costs less to read than to index.
//   4. A lane that grew `regrow` times past the size it was trained at learns its centroids again, so buckets stay
//      about `sqrt(vectors)` large.
//   5. Every number is DATA (src/search.json `vector_index`); nothing here names a lane, a model or a person.
//
// Key Concepts: an inverted-file (IVF) index: k = round(sqrt(vectors)) buckets, between `min_buckets` and
// `max_buckets`; the vectors are unit length, so the nearest centroid is the one with the largest dot product.
//

/** A kept vector (signed bytes x127, src/search.mjs quantized) as numbers of unit scale. */
export const unpacked = blob => {
  const bytes = new Int8Array(blob instanceof ArrayBuffer ? blob : blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  return Float32Array.from(bytes, value => value / 127);
};
const unitOf = vector => {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map(value => value / norm);
};
const dotOf = (a, b) => {
  if (a.length !== b.length) return -Infinity;
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index] * b[index];
  return sum;
};
const nearest = (centroids, vector) => {
  let best = null;
  for (const centroid of centroids) {
    const score = dotOf(centroid.vector, vector);
    if (!best || score > best.score) best = { bucket: centroid.bucket, score };
  }
  return best?.bucket ?? null;
};

/**
 * The index over `search_vectors` in one person's store.
 *   settings     { min_vectors, sample, iterations, probe, min_buckets, max_buckets, regrow, assign_page }
 *   transaction  fn -> runs fn in one write transaction
 * Answers { bucketOf(lane, vector), probe(lane, asked), due(), step(), changed(lane, delta) }.
 */
export function searchVectorIndex(sql, { settings, transaction = fn => fn() }) {
  const all = (query, ...values) => sql.exec(query, ...values).toArray();
  if (!all('SELECT name FROM pragma_table_info(?) WHERE name = ?', 'search_vectors', 'bucket').length) sql.exec('ALTER TABLE search_vectors ADD COLUMN bucket INTEGER');
  sql.exec('CREATE INDEX IF NOT EXISTS search_vectors_by_bucket ON search_vectors (lane, bucket)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_vector_centroids (lane TEXT NOT NULL, bucket INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (lane, bucket))');
  sql.exec('CREATE TABLE IF NOT EXISTS search_vector_trained (lane TEXT PRIMARY KEY, vectors INTEGER NOT NULL, buckets INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_vector_counts (lane TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS search_vector_generation (lane TEXT PRIMARY KEY, generation INTEGER NOT NULL)');

  // Held in memory per lane once read: the centroids, how many vectors the lane keeps, and whether some have no bucket.
  const centroidsOf = new Map();
  const counts = new Map();
  const unassigned = new Map();
  const centroids = lane => {
    if (!centroidsOf.has(lane)) centroidsOf.set(lane, all('SELECT bucket, vector FROM search_vector_centroids WHERE lane = ? ORDER BY bucket', lane)
      .map(row => ({ bucket: row.bucket, vector: new Float32Array(row.vector instanceof ArrayBuffer ? row.vector : row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength)) })));
    return centroidsOf.get(lane);
  };
  // How many vectors a lane keeps is a row (search_vector_counts) moved by changed() in the writes' own transaction, so a
  // store that starts again reads one row; counting the lane's index entries read every one of them at every start
  // (51k on a heavy account, a store that resets often). A lane with no row is counted once, and has one from then on.
  const countOf = lane => {
    if (!counts.has(lane)) {
      const [kept] = all('SELECT n FROM search_vector_counts WHERE lane = ?', lane);
      if (kept) counts.set(lane, kept.n);
      else {
        const n = all('SELECT COUNT(*) AS n FROM search_vectors WHERE lane = ?', lane)[0].n;
        sql.exec('INSERT OR REPLACE INTO search_vector_counts (lane, n) VALUES (?, ?)', lane, n);
        counts.set(lane, n);
      }
    }
    return counts.get(lane);
  };
  const trainedOf = lane => all('SELECT vectors, buckets FROM search_vector_trained WHERE lane = ?', lane)[0] ?? null;
  const generationOf = lane => {
    const [row] = all('SELECT generation FROM search_vector_generation WHERE lane = ? LIMIT 1', lane);
    if (row) return row.generation;
    sql.exec('INSERT OR IGNORE INTO search_vector_generation (lane, generation) VALUES (?, 0)', lane);
    return 0;
  };
  const advanceGeneration = lane => {
    generationOf(lane);
    sql.exec('UPDATE search_vector_generation SET generation = generation + 1 WHERE lane = ?', lane);
  };
  const hasUnassigned = lane => {
    if (!unassigned.has(lane)) unassigned.set(lane, all('SELECT 1 FROM search_vectors WHERE lane = ? AND bucket IS NULL LIMIT 1', lane).length > 0);
    return unassigned.get(lane);
  };
  // reads-ok: one seek per lane over the (lane, bucket) index, so O(lanes); SELECT DISTINCT lane walked every entry of it.
  const lanes = () => all(`WITH RECURSIVE kept(lane) AS (SELECT MIN(lane) FROM search_vectors UNION ALL SELECT (SELECT MIN(lane) FROM search_vectors WHERE lane > kept.lane) FROM kept WHERE kept.lane IS NOT NULL)
    SELECT lane FROM kept WHERE lane IS NOT NULL`).map(row => row.lane);
  let lanesKept = null;
  const knownLanes = () => (lanesKept ??= new Set(lanes()));

  // What a lane needs next: learning its centroids, giving its vectors buckets, or nothing.
  const workOf = lane => {
    const count = countOf(lane);
    if (count < settings.min_vectors) return null;
    const trained = trainedOf(lane);
    if (!trained || count >= trained.vectors * settings.regrow) return 'train';
    return hasUnassigned(lane) ? 'assign' : null;
  };

  function train(lane) {
    const count = countOf(lane);
    const k = Math.min(settings.max_buckets, Math.max(settings.min_buckets, Math.round(Math.sqrt(count))));
    const stride = Math.max(1, Math.floor(count / settings.sample));
    const sample = all('SELECT vector FROM search_vectors WHERE lane = ? AND rowid % ? = 0 LIMIT ?', lane, stride, settings.sample).map(row => unpacked(row.vector));
    if (sample.length < k) return;
    let means = Array.from({ length: k }, (_, index) => ({ bucket: index, vector: sample[Math.floor(index * sample.length / k)] }));
    for (let round = 0; round < settings.iterations; round += 1) {
      const sums = means.map(mean => ({ bucket: mean.bucket, sum: new Float32Array(mean.vector.length), members: 0 }));
      for (const vector of sample) {
        const bucket = nearest(means, vector);
        const into = sums[bucket];
        if (vector.length !== into.sum.length) continue;
        for (let index = 0; index < vector.length; index += 1) into.sum[index] += vector[index];
        into.members += 1;
      }
      // A bucket no sample chose keeps its centroid, so k stays fixed.
      means = sums.map((row, index) => ({ bucket: row.bucket, vector: row.members ? unitOf(row.sum) : means[index].vector }));
    }
    transaction(() => {
      sql.exec('DELETE FROM search_vector_centroids WHERE lane = ?', lane);
      for (const mean of means) sql.exec('INSERT INTO search_vector_centroids (lane, bucket, vector) VALUES (?, ?, ?)', lane, mean.bucket, new Uint8Array(Float32Array.from(mean.vector).buffer));
      sql.exec('UPDATE search_vectors SET bucket = NULL WHERE lane = ? AND bucket IS NOT NULL', lane);
      sql.exec('INSERT INTO search_vector_trained (lane, vectors, buckets) VALUES (?, ?, ?) ON CONFLICT (lane) DO UPDATE SET vectors = excluded.vectors, buckets = excluded.buckets', lane, count, k);
      advanceGeneration(lane);
    });
    centroidsOf.delete(lane);
    unassigned.set(lane, true);
  }

  function assign(lane) {
    const kept = centroids(lane);
    const page = all('SELECT rowid AS id, vector FROM search_vectors WHERE lane = ? AND bucket IS NULL LIMIT ?', lane, settings.assign_page);
    transaction(() => {
      for (const row of page) sql.exec('UPDATE search_vectors SET bucket = ? WHERE rowid = ?', nearest(kept, unpacked(row.vector)), row.id);
      if (page.length) advanceGeneration(lane);
    });
    if (page.length < settings.assign_page) unassigned.set(lane, false);
  }

  return {
    /** The bucket a newly kept vector (unit numbers) belongs in, or null while its lane has no centroids. */
    bucketOf(lane, vector) {
      const kept = centroids(lane);
      return kept.length ? nearest(kept, vector) : null;
    },
    /** The buckets a question (unit numbers) reads, nearest first, or null when the lane is read whole. */
    probe(lane, asked) {
      const kept = centroids(lane);
      if (!kept.length) return null;
      return kept.map(centroid => ({ bucket: centroid.bucket, score: dotOf(centroid.vector, asked) }))
        .sort((a, b) => b.score - a.score).slice(0, settings.probe).map(row => row.bucket);
    },
    /** Vectors kept (delta > 0) or let go (delta < 0) in a lane, so its size is known without counting it again. */
    changed(lane, delta, contentChanged = delta !== 0) {
      if (delta) {
        const [kept] = all('SELECT n FROM search_vector_counts WHERE lane = ?', lane);
        if (kept) sql.exec('UPDATE search_vector_counts SET n = ? WHERE lane = ?', Math.max(0, kept.n + delta), lane);
        if (counts.has(lane)) counts.set(lane, Math.max(0, counts.get(lane) + delta));
      }
      // Any result edit can change whether a vector still needs a bucket; do not let a cached empty check hide it
      // from the next alarm step.
      if (delta || contentChanged) unassigned.delete(lane);
      if (contentChanged) advanceGeneration(lane);
      knownLanes().add(lane);
    },
    /** A monotonic revision for query walks; edits, training and assignment invalidate their cursors. */
    generation: generationOf,
    /** Forget all in-memory revisions for a lane whose complete catalog slice was retired. */
    drop(lane) {
      counts.delete(lane);
      unassigned.delete(lane);
      centroidsOf.delete(lane);
      knownLanes().delete(lane);
      sql.exec('DELETE FROM search_vector_generation WHERE lane = ?', lane);
    },
    /** Whether any lane has index work waiting. */
    due: () => [...knownLanes()].some(lane => workOf(lane) !== null),
    /** One bounded piece of index work: one lane learns its centroids, or one page of vectors gets buckets. */
    step() {
      for (const lane of knownLanes()) {
        const work = workOf(lane);
        if (work === 'train') { train(lane); return { lane, work }; }
        if (work === 'assign') { assign(lane); return { lane, work }; }
      }
      return null;
    },
  };
}
