// Loaded (node --import) into the copier the copy-a-site test runs: the test's site has a public name
// (process.env.COPY_A_SITE_TEST_HOST), and this makes that one name reach this computer, as a public site would be
// reached. The copier itself is unchanged: it still refuses this computer by address, and still asks only https.
import dns from 'node:dns';

const host = process.env.COPY_A_SITE_TEST_HOST;
const lookup = dns.lookup;
dns.lookup = (name, options, done) => {
  if (typeof options === 'function') { done = options; options = {}; }
  if (name !== host) return lookup(name, options, done);
  const found = { address: '127.0.0.1', family: 4 };
  return (typeof options === 'object' && options?.all) ? done(null, [found]) : done(null, found.address, found.family);
};
