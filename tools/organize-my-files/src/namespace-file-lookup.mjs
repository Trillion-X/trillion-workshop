// A file's name is the person's own path, so it travels in the POST body of /namespace/files/lookup and never in a request
// URL that a log keeps. An identity is an opaque content id, and it is looked up the same way.
export const FILE_LOOKUP_PATH = '/namespace/files/lookup';

export const fileLookupBody = (ref, extra = {}) => ({ ...(ref.startsWith('/') ? { name: ref } : { identity: ref }), ...extra });
