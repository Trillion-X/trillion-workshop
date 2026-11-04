import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { localWorkerSettings } from './built-worker-folder.mjs';
import { chosenCloudFileOrigins, namespaceBucketBinding, namespaceWorkerVars } from './namespace-worker-vars.mjs';

// The persistent local runtime is built from an allow-list. Production bindings, IDs,
// secrets, AI, containers, remote proxies and schedules never enter it.
// Namespace files are kept where a deploy keeps them, in the app's chosen object-bucket origins
// (chosenCloudFileOrigins), each a bucket persisted under the local state; an origin reached with an
// access key is left out, as it needs the network.
const localNamespaceOrigins = () => chosenCloudFileOrigins().filter(origin => origin.interface === 'object-bucket')
  .map(origin => ({ bucket: `trillion-local-${origin.id}`, row: { id: origin.id, interface: origin.interface, max_bytes: origin.max_bytes, binding: namespaceBucketBinding(origin.id) } }));
export function localOnlyOptions({ source, out, state, rootKey, serviceActorRoot, workshopIdentity, port = 0 }) {
  if (typeof serviceActorRoot !== 'string' || !/^[0-9a-f]{64}$/i.test(serviceActorRoot)) throw new TypeError('A local service-actor derivation root is required.');
  const settings = localWorkerSettings(source);
  const modules = folder => [{ type: 'ESModule', path: join(folder, 'worker.mjs') },
    ...readdirSync(folder, { recursive: true }).filter(path => path !== 'worker.mjs' && /\.(?:m?js|wasm)$/.test(path))
      .map(path => ({ type: path.endsWith('.wasm') ? 'CompiledWasm' : 'ESModule', path: join(folder, path) }))];
  const deny = () => new Response('External network is disabled in local mode.', { status: 503 });
  const namespaceOrigins = localNamespaceOrigins();
  return {
    host: '127.0.0.1', port, cf: false, telemetry: { enabled: false },
    resourcePersistencePath: state, unsafeDevRegistryPath: undefined,
    workers: [{
      name: 'trillion-local', modules: modules(join(out, 'worker')), modulesRoot: join(out, 'worker'),
      compatibilityDate: settings.compatibility_date, compatibilityFlags: settings.compatibility_flags,
      outboundService: deny,
      bindings: { HELD_VALUES_ROOT_KEY: rootKey, SERVICE_ACTOR_DERIVATION_ROOT: serviceActorRoot,
        WORKSHOP_IDENTITY: workshopIdentity, MARKETPLACE_PUBLISHER_ACCOUNT_ID: 'trillion-local-owner', ...namespaceWorkerVars(namespaceOrigins) },
      kvNamespaces: { APP_KV: 'trillion-local-app', OAUTH_KV: 'trillion-local-oauth' },
      r2Buckets: Object.fromEntries(namespaceOrigins.map(({ bucket, row }) => [row.binding, bucket])),
      durableObjects: Object.fromEntries(settings.durable_objects.bindings.map(row => [row.name, { className: row.class_name, useSQLite: true }])),
      serviceBindings: { ENGINES: 'trillion-local-engines', NAMESPACE_MOVE_WORKER: 'trillion-local',
        SITE_WORKER_SCHEDULER: { name: 'trillion-local', entrypoint: 'SiteScheduler' } },
      assets: { directory: join(out, 'assets'), binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true } },
    }, {
      name: 'trillion-local-engines', modules: modules(join(out, 'engines')), modulesRoot: join(out, 'engines'),
      compatibilityDate: settings.compatibility_date, compatibilityFlags: settings.compatibility_flags,
      outboundService: deny,
    }],
  };
}

export const localNetworkProfile = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))(deny network-inbound)(allow network-inbound (local ip "localhost:*"))';
