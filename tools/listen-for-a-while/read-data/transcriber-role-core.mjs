// The original role liveness predicate, with storage reads supplied by its adapter.
export function transcriberRoleReader({ readJson, filesOf, data }) {
  /** The live holder of the transcriber role, or null: { who, since, beat_ms }. */
  function roleHolder(listen, now = Date.now(), rows = data) {
    const held = readJson(filesOf(listen, rows).role);
    if (!held?.who) return null;
    return now - held.beat_ms > rows.role.keepalive_ms * rows.role.lost_after_missed ? null : held;
  }
  return roleHolder;
}
