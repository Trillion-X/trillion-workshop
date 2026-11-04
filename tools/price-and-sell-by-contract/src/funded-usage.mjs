// A usage measurement is a checkpointed fold over the subjects who accepted this
// funding agreement by the end of the measured day. Only numeric counts cross the
// account boundary: each subject answers the named readings as whole numbers, summed
// here per name. A wake performs at most batch_size remote reads, not N reads.
export function makeFundedUsageReader({ read, write, subjects, measure, batch_size = 25, now = Date.now }) {
  if (!Number.isSafeInteger(batch_size) || batch_size < 1 || batch_size > 50) throw new Error('A usage read batch must be between 1 and 50.');
  return async (agreement, day, names) => {
    let state = read(agreement.subscription_id);
    if (state && state.day !== day) throw new Error('Finish the previous usage measurement before starting another day.');
    // A checkpoint kept before readings had names counted stored bytes only.
    if (state && !state.counts) state = { ...state, counts: { 'stored-bytes': state.bytes ?? 0 } };
    if (!state) {
      const ids = [...new Set(await subjects(agreement, day))];
      state = { day, ids, offset: 0, counts: Object.fromEntries(names.map(name => [name, 0])), started_at: new Date(now()).toISOString() };
      write(agreement.subscription_id, state);
    }
    const end = Math.min(state.ids.length, state.offset + batch_size);
    const totals = { ...state.counts };
    for (let i = state.offset; i < end; i += 1) {
      const counts = await measure(agreement, state.ids[i], names, day);
      for (const name of names) {
        const count = counts?.[name];
        const total = (totals[name] ?? 0) + count;
        if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total)) throw new Error('The funded usage could not be measured exactly. No usage was reported.');
        totals[name] = total;
      }
    }
    state = { ...state, offset: end, counts: totals };
    write(agreement.subscription_id, state);
    return end === state.ids.length ? totals : { pending: true, retry_at: now() + 60_000, day };
  };
}
