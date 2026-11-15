// Opens a kept browser notice before clearing it. If Trillion cannot open,
// preserve the notice so the person can try again instead of losing the target.
export async function openNotice(id, { get, open, clear, forget, markRead }) {
  const notice = await get(id);
  if (!notice) return false;
  await open(notice.open);
  await markRead(notice);
  await clear(id);
  await forget(id);
  return true;
}
