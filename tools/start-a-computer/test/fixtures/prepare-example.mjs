// tools/start-a-computer/test/fixtures/prepare-example.mjs
//
// A made-up program's own prepare module, for start-a-computer's test of the prepare step: it names no real program. Its
// greeting file is read by the unit (a change restarts it); its site file is checked by a made-up command and applied by a
// reload; each file the request hands in (`files`) is written as it came, binary ones as base64, and restarts nothing.
export function prepare({ greeting, ...unit }, { pages = [] } = {}) {
  return {
    unit: {
      ...unit,
      files: [
        { path: `/etc/example-greeter/${unit.unit}.txt`, text: `${greeting}\n` },
        { path: '/etc/example-greeter/site.conf', text: 'site\n', check: ['example-check', '--file', '{file}'], then: [['systemctl', 'reload', unit.unit]] },
        ...pages.map(({ name, bytes }) => ({ path: `/var/lib/example-greeter/${name}`, text: bytes.toString('base64'), binary: true, then: [] })),
      ],
    },
    firewall_allow: ['9000/tcp'],
  };
}
