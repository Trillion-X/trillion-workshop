// tools/compare-two-movements-side-by-side/show/video-address.ts
//
// A video's address as the screen uses it: the row's value as given when it is a full address or starts with "/", else the
// files base in front of it (a storage key). No address is made here; the base is the host's.
//
// A video has no still picture in its row, so the address carries a media fragment (#t=) naming the second to show first:
// the browser then loads that frame and paints it before anything is played. The second is the pair's start mark, at least
// 0.1 (second 0 is not always a decoded frame). A value that already has a fragment keeps it.
export const FIRST_FRAME_S = 0.1;

export const videoAddress = (value: string, filesBase = '', startS = 0): string => {
  const address = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/') ? value : `${filesBase}${value}`;
  return address.includes('#') ? address : `${address}#t=${Math.max(startS, FIRST_FRAME_S)}`;
};
