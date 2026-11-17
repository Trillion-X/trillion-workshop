// One test world for the public door: the Service connections rows in the shapes the person's list holds (with only
// the requests the door's steps name), as the values a caller hands the tools in `connections`. Synthetic names and
// documentation addresses.
import { startFakeDoor } from '../../records-door/test/fake-door.mjs';
import { openRecordsDoor } from '../../records-door/read-data/records-door.mjs';

const bearer = [{ placement: { name: 'Authorization', prefix: 'Bearer ' } }];
export const ROWS = {
  'no-public-address': { kind: 'host-you-already-run', id: 'no-public-address', name: 'A host with no public address', rents_a_host: { base: null, move_ready: false, not_ready_because: 'A host with no public IPv4 address of its own cannot serve the door yet.', placement: { address: null } } },
  'example-cloud': { kind: 'how-to-ask-something-else-to-do-things', name: 'Example Cloud', connection_id: 'service_connection:example-cloud', credential_injections: bearer,
    instrument_requests: {
      find_servers_by_name: { url: 'https://api.example.test/v1/servers?name={name}', method: 'GET' },
      create_server: { url: 'https://api.example.test/v1/servers', method: 'POST', body_template: { name: '{name}', server_type: '{server_type}', location: '{location}', image: '{image}', ssh_keys: ['{ssh_key_id}'], labels: '{labels}', public_net: { enable_ipv4: true, enable_ipv6: true } } },
      read_server: { url: 'https://api.example.test/v1/servers/{server_id}', method: 'GET' },
      delete_server: { url: 'https://api.example.test/v1/servers/{server_id}', method: 'DELETE' },
      add_ssh_key: { url: 'https://api.example.test/v1/ssh_keys', method: 'POST', body_template: { name: '{key_name}', public_key: '{public_key}', labels: '{labels}' } },
      read_ssh_key: { url: 'https://api.example.test/v1/ssh_keys/{ssh_key_id}', method: 'GET' },
      delete_ssh_key: { url: 'https://api.example.test/v1/ssh_keys/{ssh_key_id}', method: 'DELETE' } },
    rents_a_host: { base: 'https://api.example.test/v1', vault_key: 'example-cloud-token', error_code_at: 'error.code', move_ready: true, lease_label_key: 'door-lease',
      placement: { size: 'cpx21', location: 'ash', image: 'ubuntu-24.04' },
      fill: { server_type: '{size}', key_name: '{name}-access', labels: { '{lease_label_key}': '{name}' } },
      host: { find: 'find_servers_by_name', list_at: 'servers', create: 'create_server', created_at: 'server', read: 'read_server', found_at: 'server', remove: 'delete_server', id_is: 'server_id', id_pattern: '^[0-9]+$', owner_at: 'labels.{lease_label_key}', address_at: 'public_net.ipv4.ip' },
      access_key: { create: 'add_ssh_key', read: 'read_ssh_key', found_at: 'ssh_key', remove: 'delete_ssh_key', id_is: 'ssh_key_id', id_pattern: '^[0-9]+$', id_at: 'ssh_key.id', owner_at: 'labels.{lease_label_key}' } } },
  'own-box': { kind: 'host-you-already-run', id: 'own-box', name: 'Your own box over SSH', rents_a_host: { base: null, move_ready: true, placement: { address: null } } },
  'current-door': { kind: 'public-door-placement', id: 'current', name: 'Where the public door runs', hosting_provider: 'example-cloud', hostname: 'door.example.com',
    server_id: null, address: null, dns_record: null, lease_file: null, unknown_because: 'Not read yet.', proof: { health: '/healthz', download: '/download/App.dmg' } },
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

/** A made-up DNS provider's description, in the shape the person keeps it in (example.test answers nothing). */
export const DNS = {
  id: 'example-dns', name: 'Example DNS', base: 'https://dns.example.test/v1', auth: { header: 'X-Dns-Key', prefix: '' }, vault_key: 'example-dns-token',
  error_code_at: 'problem', ok_at: 'ok', lease_label_key: 'dns-owner',
  requests: {
    find_zone: { url: 'https://dns.example.test/v1/zones?domain={zone}', method: 'GET' },
    list_rules: { url: 'https://dns.example.test/v1/zones/{zone_id}/rules', method: 'GET' },
    list_records: { url: 'https://dns.example.test/v1/zones/{zone_id}/records?page={page}', method: 'GET' },
    add_record: { url: 'https://dns.example.test/v1/zones/{zone_id}/records', method: 'POST', body_template: { kind: 'A', host: '{host_name}', value: '{address}', ttl: 30, note: '{lease_label_key} {name}' } },
    add_given: { url: 'https://dns.example.test/v1/zones/{zone_id}/records', method: 'POST', body_template: '{record_body}' },
    change_record: { url: 'https://dns.example.test/v1/zones/{zone_id}/records/{record_id}', method: 'PATCH', body_template: '{record_body}' },
    drop_record: { url: 'https://dns.example.test/v1/zones/{zone_id}/records/{record_id}', method: 'DELETE' },
    list_links: { url: 'https://dns.example.test/v1/accounts/{account_id}/links', method: 'GET' },
    add_link: { url: 'https://dns.example.test/v1/accounts/{account_id}/links', method: 'PUT', body_template: '{binding_body}' },
    drop_link: { url: 'https://dns.example.test/v1/accounts/{account_id}/links/{binding_id}', method: 'DELETE' },
  },
  zone: { find: 'find_zone', list_at: 'items', id_is: 'zone_id', id_pattern: '^[a-f0-9]{8}$', id_at: 'id', account_at: 'account', guards: [{ request: 'list_rules', list_at: 'items' }] },
  record: { list: 'list_records', list_at: 'items', pages_at: 'pages', create: 'add_record', create_given: 'add_given', created_at: 'item', update: 'change_record', remove: 'drop_record',
    id_is: 'record_id', id_pattern: '^[a-f0-9]{8}$', id_at: 'id', name_at: 'host', type_at: 'kind', content_at: 'value', address_types: ['A', 'AAAA', 'CNAME'], editable_types: ['A', 'CNAME'],
    fields: ['id', 'kind', 'host', 'value', 'ttl', 'proxied', 'note'], desired: { kind: 'A', host: '{host_name}', value: '{address}', ttl: 30, proxied: false },
    read_only_at: 'locked', binding_at: 'link_id', owner_at: 'note', owner_is: '{lease_label_key} {name}' },
  binding: { list: 'list_links', list_at: 'items', create: 'add_link', remove: 'drop_link', id_is: 'binding_id', id_pattern: '^[a-f0-9]{8,40}$', id_at: 'id', host_at: 'host',
    fields: ['host', 'target', 'stage'], restore_fields: ['host', 'target'], require: { stage: 'live' } },
};
