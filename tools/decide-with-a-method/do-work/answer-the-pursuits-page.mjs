  // What the person is pursuing: the changes every decision is weighed against. An ended pursuit is marked ended
  // rather than erased, so its history stays.
  async pursuits() { return Object.values((await this.#read({ cases: [] })).pursuits ?? {}).filter(currentPursuit); }

  // Each pursuit sent is added or updated by its id (an id list_pursuits returned names the same pursuit). With
  // replace_all, the list is the whole current list and every pursuit left out is ended, as when one AI records
  // everything it found; without it, one AI adding a pursuit never ends the ones another AI recorded.
  async recordPursuits(list, { replace_all: replaceAll = false } = {}) {
    // Both are the caller's request refused (400 on every road, src/failure.mjs refusalStatus), never a failure of the store.
    if (!Array.isArray(list) || !list.length) throw Object.assign(new Error('pursuits needs at least one pursuit'), { status: 400 });
    const cleaned = list.map((item, index) => {
      if (!object(item) || !nonempty(item.title) || !nonempty(item.now) || !nonempty(item.after)) throw Object.assign(new Error(`Pursuit ${index + 1} needs a title, where it is now, and where it should get to`), { status: 400 });
      // A pursuit's title and where it is going are shown to the person on every screen and widget: they are written to
      // them ("your files"), never about them ("his files").
      const about = ['title', 'after'].find(part => ABOUT_SOMEONE.test(item[part]));
      if (about) throw new Error(`Pursuit ${index + 1}: write its ${about} to the person, as "you" and "your", never "he", "his", "she" or "her" (it is shown to them). When it is about someone else, name them: "Morgan's deck".`);
      const id = 'pursuit:' + (nonempty(item.id) ? item.id.replace(/^pursuit:/, '') : item.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return [id, { ...item, id, kind: 'pursuit', status: nonempty(item.status) ? item.status : 'active' }];
    });
    return this.#change(state => {
      state.pursuits ??= {};
      const at = new Date().toISOString();
      const next = new Map(cleaned);
      // A pursuit with a room (people or things kept with it) is never ended by a whole-list rewrite: ending it is its own
      // action (src/pursuit-rooms.mjs endPursuit), so an AI's list of what it found never drops a shared pursuit.
      if (replaceAll) for (const [id, item] of Object.entries(state.pursuits)) if (!next.has(id) && currentPursuit(item) && !item.space_id) state.pursuits[id] = { ...item, status: 'ended', ended_at: at };
      // The room a pursuit's people and shared things live in (src/pursuit-rooms.mjs) belongs to the pursuit, not to
      // what an AI sent: a rewrite that leaves it out keeps it, and only src/pursuit-rooms.mjs sets it (changePursuits).
      for (const [id, item] of next) {
        const { space_id: _sent, ...rest } = item;
        const room = state.pursuits[id]?.space_id;
        state.pursuits[id] = { ...rest, ...(room ? { space_id: room } : {}), recorded_at: at };
      }
      return Object.values(state.pursuits).filter(currentPursuit);
    }, []);
