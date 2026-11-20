// tools/list-and-run-my-tools-for-any-ai/test/saved-and-listed-database.mjs
//
// A stand-in for the database the save, publish and delete steps write: `saved_tools` and `marketplace_listings`. It answers
// only the statements those steps run, and it throws on any other, so a test fails when a step sends a statement it does not
// know. Shared by delete-tool.test.mjs and publish-screen-rows.test.mjs.
export function savedAndListedDatabase({ saved = [], listings = [] } = {}) {
  const state = { saved: saved.map(row => ({ status: null, deleted_at: null, ...row })), listings: [...listings], log: [] };
  const liveOnly = text => /status IS DISTINCT FROM 'deleted'/.test(text);
  state.client = {
    query: async (text, values = []) => {
      const head = text.trim();
      state.log.push(head.split(/\s+/).slice(0, 3).join(' '));
      if (/^(CREATE|ALTER|BEGIN|COMMIT|ROLLBACK)\b/.test(head)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO saved_tools/.test(head)) {
        const row = { id: values[0], descriptor: JSON.parse(values[1]), files: values[2], fingerprint: values[3], made_at: values[4], status: null, deleted_at: null };
        state.saved = state.saved.filter(item => item.id !== row.id).concat(row);
        return { rows: [], rowCount: 1 };
      }
      if (/^SELECT id, descriptor, fingerprint, files FROM saved_tools/.test(head)) {
        const rows = state.saved.filter(row => row.id === values[0] && (!liveOnly(text) || row.status !== 'deleted'));
        return { rows, rowCount: rows.length };
      }
      if (/^SELECT id FROM saved_tools/.test(head)) {
        const rows = state.saved.filter(row => row.id === values[0] && (!liveOnly(text) || row.status !== 'deleted')).map(row => ({ id: row.id }));
        return { rows, rowCount: rows.length };
      }
      if (/^UPDATE saved_tools SET status = 'deleted'/.test(head)) {
        const row = state.saved.find(item => item.id === values[0]);
        if (row) Object.assign(row, { status: 'deleted', deleted_at: new Date().toISOString() });
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if (/^SELECT maker, status FROM marketplace_listings/.test(head) || /^SELECT maker FROM marketplace_listings/.test(head)) {
        const rows = state.listings.filter(row => row.tool_id === values[0]).map(row => ({ maker: row.maker, status: row.status }));
        return { rows, rowCount: rows.length };
      }
      if (/^INSERT INTO marketplace_listings/.test(head)) {
        const row = {
          tool_id: values[0], maker: values[1], status: 'published', fingerprint: values[2], price_ref: values[3],
          usage_price: values[4] ? JSON.parse(values[4]) : null, show_on_public_site: values[5],
          public_run: values[6] ? JSON.parse(values[6]) : null, body: values[7], files: values[8],
        };
        state.listings = state.listings.filter(item => item.tool_id !== row.tool_id).concat(row);
        return { rows: [{ tool_id: row.tool_id, maker: row.maker, status: row.status, fingerprint: row.fingerprint, price_ref: row.price_ref,
          usage_price: row.usage_price, show_on_public_site: row.show_on_public_site, public_run: row.public_run, published_at: 'now' }], rowCount: 1 };
      }
      throw new Error(`the test database does not answer this statement: ${head.slice(0, 80)}`);
    },
  };
  return state;
}
