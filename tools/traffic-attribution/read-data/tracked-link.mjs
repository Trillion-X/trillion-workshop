/** A URL builder shared by package consumers and the Media Workspace server. */
export function buildTrackedLink(input) {
  const destination = input?.destination?.trim();
  let url;
  try {
    url = new URL(destination);
  } catch {
    throw new Error('The destination must be a valid web URL.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('The destination must be a web URL without account details.');
  }
  if (typeof input.projectId !== 'string' || !/^[a-z0-9._-]+$/i.test(input.projectId.trim())) {
    throw new Error('A valid project ID is required for a tracked link.');
  }
  const fields = [
    ['bf_project', input.projectId, true],
    ['utm_source', input.source, true],
    ['utm_campaign', input.campaign, true],
    ['utm_medium', input.medium, false],
    ['utm_content', input.content, false],
  ];
  for (const [key, raw, required] of fields) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (required && !value) throw new Error(`${key} is required for a tracked link.`);
    if (value.length > 256) throw new Error(`${key} is too long for traffic capture.`);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  return url.toString();
}
