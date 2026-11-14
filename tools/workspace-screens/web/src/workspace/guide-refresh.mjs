// A guide's owner can say when its current answer expires. Replace the deadline on every answer and cancel on
// disposal; a timed rule or provider observation must not leave an old action visible until an unrelated write.
export function guideRefresh(reload, { now = Date.now, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer = null;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  return {
    readAt(deadline) {
      clear();
      if (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= 0) return;
      // A response can arrive just after its deadline. Re-read once, without a zero-delay loop or timer overflow.
      const delay = Math.max(1000, Math.min(2147483647, deadline - now()));
      timer = schedule(() => { timer = null; void reload(); }, delay);
    },
    clear,
  };
}
