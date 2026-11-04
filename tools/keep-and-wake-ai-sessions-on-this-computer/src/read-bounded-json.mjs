// Read JSON without buffering beyond the transport limit. Non-ASCII text counts by wire bytes.
export async function readBoundedJson(request, maxBytes, tooLarge) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // A cloned request is a tee: awaiting cancellation waits for its unread sibling and deadlocks
        // pre-handler admission. Cancel this reader immediately; the owner can still read/refuse its branch.
        void reader.cancel().catch(() => {});
        throw tooLarge;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return size ? JSON.parse(new TextDecoder().decode(bytes)) : {};
}
