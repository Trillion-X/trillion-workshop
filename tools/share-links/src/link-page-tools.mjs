// The MCP tools for a person's link-in-bio page (src/link-page.mjs): reading it with its address for each place and what
// people opened there, and changing it. The same owner answers the Link in bio screen and tool:link-in-bio.
const link = { type: 'object', required: ['label', 'url'], properties: { label: { type: 'string', description: 'The words people see' }, url: { type: 'string', format: 'uri', description: 'A full https address' }, link_id: { type: 'string', description: 'Kept from read_link_page to keep its counts' } } };

export const linkPageTools = call => [
  { name: 'read_link_page', description: 'This person\'s link-in-bio page: whether it is on, its address, one address per place (addresses_by_place, each with ?from=<place> so visits from each place are counted apart; address_for_a_place for any other place), its unique public name when they hold one (name; the address then reads /l/<name> and code_address keeps the random-code address), its title and line, their own links, the published posts with a link it lists, and counts: visits and opens in all and over the last days, by place (by_place) and by what was opened (by_item, each post_id or link_id with opens per place). Every open leaves tagged with the place and the post or link, so a sign-up says where it came from. It changes nothing.', inputSchema: { type: 'object', properties: {} }, run: () => call('/link-page') },
  { name: 'set_link_page', description: 'Changes this person\'s link-in-bio page and returns what read_link_page returns. on turns it on or off (off hides it from everyone; the address stays the same for when it is turned on again); name claims their optional unique public name (3 to 30 lowercase letters, numbers and hyphens; refused when someone else has it), which becomes the page\'s address /l/<name> while the random-code address keeps working, and null releases it (a new name releases the old one); title and about are its heading and line; links replaces the whole list of their own links (each { label, url }, keep link_id from read_link_page to keep its counts); add_link adds one link; remove_link removes one by link_id. Setting links for the first time turns the page on. Their published posts that carry a link are listed by themselves.', inputSchema: {
    type: 'object',
    properties: {
      on: { type: 'boolean' },
      name: { type: ['string', 'null'], description: 'Your unique public name, like sam-rivera; null releases it' },
      title: { type: 'string' },
      about: { type: 'string' },
      links: { type: 'array', items: link },
      add_link: link,
      remove_link: { type: 'string', description: 'A link_id from read_link_page' },
    },
  }, run: input => call('/link-page', input ?? {}) },
];

export const linkPageAnnotations = {
  read_link_page: { title: 'Read my link-in-bio page and what people opened', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_link_page: { title: 'Change my link-in-bio page', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};
