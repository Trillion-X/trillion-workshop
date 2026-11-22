// src/workspace/address-open.mjs
//
// PURPOSE
//   The screens a page's address asks for, and the one time they open. A tool's own screen (the grants screen at
//   /grants) is offered only when the tools' answer arrives; a page that read the address before that answer found no
//   screen and fell back to Home. The page asks again each time the offered screens change, so the address opens its
//   screens as soon as they are offered, and only once.
//
// NON-NEGOTIABLE INVARIANTS
//   1. An address opens nothing until a screen it asks for is offered: no offered screen, no request, no fallback.
//   2. An address opens its screens once. A later offer never opens them again, so a screen the person closed stays closed.
//   3. The resolution is addresses.mjs (screenAt, screensAtAddress), the same one the Worker answers the address with.

import { screenAt, screensAtAddress } from './addresses.mjs';

const openRequest = ({ row, input }) => (input ? { id: row.id, surfaceInput: { ...row.surface_input, ...input } } : row);

/** The open requests an address asks of the offered screens: its path's screen, and each query's screen beside it. */
export function requestsOfAddress(rows, pathname, search = '') {
  const routed = screenAt(rows, pathname, search);
  return screensAtAddress(rows, pathname, search).map((asked, index) => {
    const request = openRequest(asked);
    return routed && index > 0 ? { ...request, placement: 'right' } : request;
  });
}

/** A reader of an address's requests that answers them the first time the offered screens ask for something, then nothing. */
export function addressOpener() {
  let opened = false;
  return (rows, pathname, search = '') => {
    if (opened) return [];
    const requests = requestsOfAddress(rows, pathname, search);
    opened = requests.length > 0;
    return requests;
  };
}
