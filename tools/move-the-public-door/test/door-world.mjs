// One test world for the public door: the Service connections rows in the shapes the person's list holds (with only
// the requests the door's steps name), as the values a caller hands the tools in `connections`. Synthetic names and
// documentation addresses.
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';

const bearer = [{ placement: { name: 'Authorization', prefix: 'Bearer ' } }];
export const ROWS = {
  fly: { kind: 'how-to-ask-something-else-to-do-things', name: 'Fly.io', connection_id: 'service_connection:fly', credential_injections: bearer,
    instrument_requests: {
      list_machines: { url: 'https://api.machines.dev/v1/apps/{which_app}/machines', method: 'GET' },
      read_machine: { url: 'https://api.machines.dev/v1/apps/{which_app}/machines/{which_machine}', method: 'GET' },
      create_machine: { url: 'https://api.machines.dev/v1/apps/{which_app}/machines', method: 'POST', body_template: { name: '{name}', region: '{region}', config: '{config}' } },
      destroy_machine: { url: 'https://api.machines.dev/v1/apps/{which_app}/machines/{which_machine}?force=true', method: 'DELETE' } },
    rents_a_host: { base: 'https://api.machines.dev/v1', vault_key: 'fly-api-token', error_code_at: 'error', move_ready: false,
      not_ready_because: 'A Fly Machine has no public IPv4 of its own (the address belongs to the app) and takes no root SSH key, so the door setup cannot run on it yet.',
      placement: { size: 'shared-cpu-2x', location: 'iad', image: 'ubuntu:24.04', which_app: null },
      fill: { region: '{location}', config: { image: '{image}', guest: { cpu_kind: 'shared', cpus: 2, memory_mb: 4096 }, metadata: { 'door-lease': '{name}' } } },
      host: { find: 'list_machines', create: 'create_machine', read: 'read_machine', remove: 'destroy_machine', id_is: 'which_machine', id_pattern: '^[0-9a-f]{14}$', owner_at: 'config.metadata.door-lease', address_at: 'private_ip' },
      access_key: null } },
  hetzner: { kind: 'how-to-ask-something-else-to-do-things', name: 'Hetzner Cloud', connection_id: 'service_connection:hetzner', credential_injections: bearer,
    instrument_requests: {
      find_servers_by_name: { url: 'https://api.hetzner.cloud/v1/servers?name={name}', method: 'GET' },
      create_server: { url: 'https://api.hetzner.cloud/v1/servers', method: 'POST', body_template: { name: '{name}', server_type: '{server_type}', location: '{location}', image: '{image}', ssh_keys: ['{ssh_key_id}'], labels: '{labels}', public_net: { enable_ipv4: true, enable_ipv6: true } } },
      read_server: { url: 'https://api.hetzner.cloud/v1/servers/{server_id}', method: 'GET' },
      delete_server: { url: 'https://api.hetzner.cloud/v1/servers/{server_id}', method: 'DELETE' },
      add_ssh_key: { url: 'https://api.hetzner.cloud/v1/ssh_keys', method: 'POST', body_template: { name: '{key_name}', public_key: '{public_key}', labels: '{labels}' } },
      read_ssh_key: { url: 'https://api.hetzner.cloud/v1/ssh_keys/{ssh_key_id}', method: 'GET' },
      delete_ssh_key: { url: 'https://api.hetzner.cloud/v1/ssh_keys/{ssh_key_id}', method: 'DELETE' } },
    rents_a_host: { base: 'https://api.hetzner.cloud/v1', vault_key: 'hetzner-api-token', error_code_at: 'error.code', move_ready: true,
      placement: { size: 'cpx21', location: 'ash', image: 'ubuntu-24.04' },
      fill: { server_type: '{size}', key_name: '{name}-access', labels: { 'door-lease': '{name}' } },
      host: { find: 'find_servers_by_name', list_at: 'servers', create: 'create_server', created_at: 'server', read: 'read_server', found_at: 'server', remove: 'delete_server', id_is: 'server_id', id_pattern: '^[0-9]+$', owner_at: 'labels.door-lease', address_at: 'public_net.ipv4.ip' },
      access_key: { create: 'add_ssh_key', read: 'read_ssh_key', found_at: 'ssh_key', remove: 'delete_ssh_key', id_is: 'ssh_key_id', id_at: 'ssh_key.id' } } },
  'own-box': { kind: 'host-you-already-run', id: 'own-box', name: 'Your own box over SSH', rents_a_host: { base: null, move_ready: true, placement: { address: null } } },
  'current-door': { kind: 'public-door-placement', id: 'current', name: 'Where the public door runs', hosting_provider: 'hetzner', dns_provider: 'cloudflare', hostname: 'door.example.com',
    server_id: null, address: null, dns_record: null, lease_file: null, unknown_because: 'Not read yet.', proof: { health: '/healthz', download: '/download/App.dmg' } },
  cloudflare: { kind: 'how-to-ask-something-else-to-do-things', name: 'Cloudflare', connection_id: 'service_connection:cloudflare', credential_injections: bearer,
    points_a_name: { base: 'https://api.cloudflare.com/client/v4', vault_key: 'cloudflare-api-token' } },
};

/** The values of the rows, each edited first by `edit(value, name)`: what a caller hands a tool as `connections`. */
export const connectionValues = (edit = () => {}) => Object.entries(structuredClone(ROWS)).map(([name, value]) => { edit(value, name); return value; });

/** A records door over the stand-in holding the rows (list right only), closed when the test ends: for the one tool that reads the list. */
export async function listDoor(t) {
  const records = Object.entries(structuredClone(ROWS)).map(([name, value]) => ({ id: `record:service-connection:${name}`, type: 'record:service-connection', value }));
  const fake = await startFakeDoor({ rights: [{ kind: 'record:service-connection', operations: ['records:list'] }], records });
  t.after(() => fake.close());
  return openRecordsDoor({ descriptor: fake.descriptor, wait: async () => {} });
}
