// The MCP tool for what a person's own devices report about themselves (src/device-facts.mjs): the same report a signed-in
// page makes (POST /work/api/device-facts), for anyone holding the account key, so a Mac that sees a camera can say so.
// The facts are checked by src/device-facts.json and kept as the person's device facts.
export const deviceFactsTools = call => [
  { name: 'report_device_facts', description: 'Says what one of the person\'s own devices reports about itself, such as the cameras a computer sees (cameras: "CAM-100"). A Waiting on you step about a device shows only once something of theirs shows that device.', inputSchema: {
    type: 'object',
    required: ['device', 'facts'],
    properties: {
      device: { type: 'string', description: 'Which device this is, such as the computer\'s name' },
      device_id: { type: 'string', description: 'Stable profile identity for reports that combine observations from multiple sources' },
      source: { type: 'string', description: 'Name of the source that owns this complete fact snapshot' },
      generation: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^\\d{16}-page-[a-z0-9-]{1,60}-\\d{8}$' }], description: 'Increasing version for this source snapshot' },
      facts: { type: 'object', description: 'Short facts as { name: text }, such as { "cameras": "CAM-100" }. Names are lowercase letters, digits, dots and dashes.', additionalProperties: { type: 'string' } },
    },
  }, run: ({ device, facts, device_id, source, generation }) => {
    const supplied = [device_id, source, generation].filter(value => value !== undefined).length;
    if (supplied !== 0 && supplied !== 3) throw new TypeError('device_id, source and generation must be supplied together');
    return call('/device-facts', {
      device, facts, ...(device_id === undefined ? {} : { device_id, source, generation }),
    });
  } },
];

export const deviceFactsAnnotations = {
  report_device_facts: { title: 'Say what my device reports', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
