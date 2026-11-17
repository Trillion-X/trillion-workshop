// A stand-in for the transport that fetches an AI product's client metadata document (settings.cimd.fetch_module): it answers from
// `documents` (URL to document) as an https server would, so a test registers a client the way Claude or ChatGPT does without a
// network, a certificate or a public name. Better Auth's own transport (@better-auth/cimd/node) is for the real thing.
export const documents = new Map();

export const fetchClientMetadataResource = async input => {
  const url = new URL(new Request(input).url).toString();
  const document = documents.get(url);
  if (!document) return new Response('not found', { status: 404 });
  return new Response(JSON.stringify(document), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } });
};
