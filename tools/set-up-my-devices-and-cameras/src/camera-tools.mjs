// Network camera tools. A camera is a Cloudflare Stream live input that Trillion receives and keeps (src/camera-live.mjs).
// The ingest key is stored when the camera is made and is never part of any answer here: the Always recording screen
// copies it for the person.
const name = { type: 'string', minLength: 1, maxLength: 60, description: 'A few plain words naming the camera, like "Front court".' };

export const cameraTools = call => [
  { name: 'connect_camera', description: 'Make a network camera that streams to Trillion, or answer the one already named that. Returns the RTMPS (and SRT) address to type into the camera, the address to watch it live, and the folder its finished recordings are filed into (/Recordings/Cameras/{day}/). The stream key is stored and is not returned: the person copies it from the Always recording screen ("Copy camera key"). Only the account that runs this Trillion can make cameras.',
    inputSchema: { type: 'object', required: ['name'], properties: { name } },
    run: ({ name: label }) => call('/cameras', { name: label }) },
  { name: 'list_cameras', description: 'List this account\'s network cameras with their ingest address, watch address, key hint (last four characters only) and the last recording filed.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('/cameras', undefined, 'GET') },
  { name: 'file_camera_recordings', description: 'File finished camera recordings into /Recordings/Cameras now, instead of waiting for Stream\'s notice. Safe to repeat: a recording already filed is not copied twice, and one cut short resumes where it stopped.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('/cameras/file', {}) },
  { name: 'remove_camera', description: 'Remove a network camera and its live input at Stream. Recordings already filed stay in Files.',
    inputSchema: { type: 'object', required: ['camera_id'], properties: { camera_id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$' } } },
    run: ({ camera_id }) => call(`/cameras/${camera_id}`, undefined, 'DELETE') },
];

export const cameraAnnotations = {
  connect_camera: { title: 'Connect a network camera', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  list_cameras: { title: 'List network cameras', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  file_camera_recordings: { title: 'File camera recordings', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  remove_camera: { title: 'Remove a network camera', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
};
