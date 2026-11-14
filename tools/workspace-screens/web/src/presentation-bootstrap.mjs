// The shipped presentation DATA: the rows every page plays (feel, delight) and the words every tour says (tour-words),
// as the app carries them. The presentation owner (presentation-content.mjs) answers these when no env publishes newer
// sections; the page reads them here (workspace/presentation-rows.mjs), since the engine has no presentation route.
export const presentationBootstrap = {
  feel: () => import('../records/feel-moments.json', { with: { type: 'json' } }).then(module => module.default),
  delight: () => import('../records/delight-moments.json', { with: { type: 'json' } }).then(module => module.default),
  'tour-words': () => import('./workspace/tour-words.json', { with: { type: 'json' } }).then(module => module.default),
};
