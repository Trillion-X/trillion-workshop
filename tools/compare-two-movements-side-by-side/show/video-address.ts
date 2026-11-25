// tools/compare-two-movements-side-by-side/show/video-address.ts
//
// A video's address as the screen uses it: the row's value as given when it is a full address or starts with "/", else the
// files base in front of it (a storage key). No address is made here; the base is the host's.
export const videoAddress = (value: string, filesBase = ''): string =>
  /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') ? value : `${filesBase}${value}`;
