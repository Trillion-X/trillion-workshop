// The deep primitive: an address and opaque operation envelope reach the actual
// installed behavior. Storage, commit/CAS, carrier, host and contracts are supplies.
// A remote transactional owner implements its own asynchronous commitment; it is
// never passed off as the synchronous record ABI of a local realization.
export function makeAddressedOperation({ resolve } = {}) {
  if (typeof resolve !== 'function') throw new TypeError('An installed address resolver is required.');
  return async (envelope, context) => {
    if (!envelope || envelope.address === undefined || envelope.operation === undefined) throw new TypeError('An addressed operation envelope is required.');
    const installed = await resolve(envelope.address, context);
    if (typeof installed?.invoke !== 'function') throw Object.assign(new Error('No executable behavior is installed at this address.'), { status: 404 });
    return installed.invoke(envelope, context);
  };
}
