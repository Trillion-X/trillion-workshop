// tools/start-a-computer/test/fixtures/prepare-example.mjs
//
// A made-up program's own prepare module, for start-a-computer's test of the prepare step: it names no real program.
export function prepare({ greeting, ...unit }) {
  return {
    unit: { ...unit, files: [{ path: `/etc/example-greeter/${unit.unit}.txt`, text: `${greeting}\n` }] },
    firewall_allow: ['9000/tcp'],
    routes: ['example-route'],
  };
}
