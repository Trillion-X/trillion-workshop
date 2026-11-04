  async function finish(question, { places = null, sources = null, matches = null, limit = config.limit } = {}, partial = null) {
    question = String(question ?? '').trim().slice(0, 500);
    const terms = [...new Set(words(question).filter(word => word.length >= config.min_word_length))];
    const lanes = planned(places, sources, matches);
    const given = partial ?? { answered: lanes.map(() => null), unavailable: [], pending: [], still_reading: Object.fromEntries(lanes.filter(lane => INDEX_MATCHES.has(lane.match)).map(lane => [lane.id, 1])) };
    const unavailable = [...given.unavailable], pending = [...given.pending];
    const participated = new Map(Object.entries(given.participated ?? {}));
    const report = {
      unavailable: (lane, reason) => unavailable.push({ lane: lane.id, place: lane.place, source: lane.source, reason }),
      pending: lane => pending.push({ lane: lane.id, place: lane.place, source: lane.source }),
    };
    const answered = question ? await Promise.all(lanes.map(async (lane, at) => {
      if (INDEX_MATCHES.has(lane.match)) return given.answered[at] ?? [];
      try {
        const found = await mechanisms[lane.match](lane, { question, terms, report });
        if (!unavailable.some(item => item.lane === lane.id) && !pending.some(item => item.lane === lane.id)) participated.set(lane.id, [lane.id]);
        return found.map(hit => ({ ...hit, lane }));
      }
      catch (error) { report.unavailable(lane, reasonOf(error)); return []; }
    })) : [];
    // An index lane still reading is still working, as a picture model starting is: it is named pending, so every screen
    // and AI that reads this answer asks again rather than taking an empty answer as final (a follower still rebuilding).
    if (question) for (const lane of lanes) if (given.still_reading?.[lane.id] && !pending.some(item => item.lane === lane.id)) report.pending(lane);
    // A file the person deleted or archived and left with no name is not found until it is put back.
    const found = answered.flat();
    const hidden = hiddenAmong(sql, found.map(hit => hit.identity));
    const shown = hidden.size ? found.filter(hit => !hidden.has(hit.identity)) : found;
    const canonical = canonicalFiles([...new Set(shown.filter(hit => hit.identity).map(hit => hit.identity))]);
    const keyOf = hit => (hit.identity ? `file:${canonical.get(hit.identity)}` : hit.key);

    // Each lane's own ranking (its hits by score, one place per thing); a word-index lane whose best hit holds few of
    // the asked words sits this question out (the word gate, measured held-out in the find-by-meaning plan §9).
    const fusion = config.fusion ?? {};
    const rankings = new Map();
    for (const hit of [...shown].sort((a, b) => b.score - a.score)) {
      const ranking = rankings.get(hit.lane.id) ?? { lane: hit.lane, keys: [] };
      rankings.set(hit.lane.id, ranking);
      if (!ranking.keys.includes(keyOf(hit))) ranking.keys.push(keyOf(hit));
    }
    const satOut = [];
    for (const [id, { lane, keys }] of rankings) {
      if (lane.match !== 'words-in-index' || !terms.length || !Number.isFinite(fusion.word_confidence_floor)) continue;
      const best = shown.find(hit => hit.lane.id === id && keyOf(hit) === keys[0]);
      const held = words(best?.said ?? '');
      if (terms.filter(term => held.some(word => word.startsWith(term))).length / terms.length < fusion.word_confidence_floor) { rankings.delete(id); satOut.push({ lane: id, reason: 'its best match holds few of the asked words' }); }
    }
    const hits = shown.filter(hit => rankings.has(hit.lane.id));
    const weights = answers ? answers.weights([...rankings.keys()]) : {};
    const k = Number.isFinite(fusion.k) ? fusion.k : 60;
