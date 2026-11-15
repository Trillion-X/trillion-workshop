// Ledger identities, address protocols and bounded delivery limits retained from
// old src/audience-sends.json. Choices and words are read from list rows.
export const audiencePolicy = Object.freeze({
  send_type: 'audience-send', delivery_type: 'audience-delivery', share_index_type: 'audience-share',
  do_not_send_type: 'audience-do-not-send', page_size: 25, most_source_pages: 100,
  most_source_rows_per_page: 100, stale_claim_minutes: 15, next_page_after_seconds: 60,
  most_channel_attempts: 3, retry_after_seconds: 3600, most_prices: 6,
  addresses: {
    email: { field_kinds: ['email'], pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' },
    phone: { field_kinds: ['phone'], pattern: '^\\+[1-9]\\d{7,14}$' },
    postal: { field_kinds: ['postal-address'], pattern: '\\S' },
  },
  channels: [], timings: [], audience_states: {}, words: {}, screen: {},
});
