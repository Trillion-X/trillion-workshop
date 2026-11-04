// Immutable files published by the service live beside, but outside, people's namespace keys in the
// deployment's object bucket. Their BLAKE3 identity is the key; the service verifies the bytes at both ends.
export const PUBLISHED_FILE_PREFIX = 'published/files/';
export const publishedFileKey = identity => `${PUBLISHED_FILE_PREFIX}${identity}`;
