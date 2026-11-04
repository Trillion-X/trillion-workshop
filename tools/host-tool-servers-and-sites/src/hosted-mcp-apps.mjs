// src/hosted-mcp-apps.mjs
//
// Stdio tool servers of public repositories, hosted so every account can use them. records/hosted-mcp-apps.json is the
// one list (a `service`, and one row per app: its pinned release, archive hash, the command that starts its stdio
// server, and plain words about what it does). Everything else is derived from it here, blind to which apps they are:
//
//   hostedRowsFor(doc)       the hosted-service row (its image built from Dockerfile lines that install every pinned
//                            release, then start parts/stdio-mcp-gateway) and the hosted-site row that gives it a host
//                            (scripts/hosted-rows.mjs adds both to the rows the deploy stores);
//   gatewayConfig(doc)       the gateway's own config (which app runs which command, the session limits);
//   liveSourcesFor(doc)      one live tool source per app for every account (src/live-tool-source-config.mjs): kind mcp,
//                            at https://<host>/<app>/mcp, with the app's licence, maker, page and about words.
//
// Invariants: a release is installed only if its archive's BLAKE3 hash is the pinned one; the image runs as a user with no
// secrets and no environment; adding an app is adding a row to the records file.
const GATEWAY_FOLDER = '/opt/stdio-mcp-gateway';
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

export const appUrl = (doc, app) => `https://${doc.service.host}/${app.name}/mcp`;

export function gatewayConfig(doc) {
  const { gateway = {}, port } = doc.service;
  return {
    port,
    ...gateway,
    apps: Object.fromEntries(doc.apps.map(app => [app.name, { cli: `/usr/local/bin/${app.cli}`, args: app.mcp_args }])),
  };
}

// The Dockerfile (one line per entry) and the files copied into its build folder: the gateway's own files from this
// repository (`from`), and its config (`content`).
export function imageBuild(doc, gatewayFiles = ['gateway.mjs', 'serve.mjs']) {
  const { base_image: base, user } = doc.service;
  const install = app => {
    const folder = `/tmp/${app.name}`;
    return `RUN set -eux; mkdir -p ${folder}; curl -fsSL --retry 3 -o ${folder}.tgz ${quote(app.asset_url)}; echo ${quote(`${app.blake3}  ${folder}.tgz`)} | b3sum --check -; tar xzf ${folder}.tgz -C ${folder} --strip-components=1; install -m 0755 ${folder}/bin/${app.cli} /usr/local/bin/${app.cli}; mkdir -p /usr/share/doc/${app.name}; cp -r ${folder}/share/doc/${app.name}/. /usr/share/doc/${app.name}/ || true; rm -rf ${folder} ${folder}.tgz`;
  };
  return {
    dockerfile_lines: [
      `FROM --platform=linux/amd64 ${base}`,
      'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl b3sum && rm -rf /var/lib/apt/lists/*',
      ...doc.apps.map(install),
      `COPY gateway/ ${GATEWAY_FOLDER}/`,
      `USER ${user}`,
      `EXPOSE ${doc.service.port}`,
    ],
    files: [
      ...gatewayFiles.map(name => ({ path: `gateway/${name}`, from: `parts/stdio-mcp-gateway/do-work/${name}` })),
      { path: 'gateway/config.json', content: `${JSON.stringify(gatewayConfig(doc), null, 2)}\n` },
    ],
  };
}

export function hostedRowsFor(doc) {
  const { service } = doc;
  return [
    {
      kind: 'hosted-service', id: service.id, label: service.label, vendor: 'Cloudflare Containers',
      billing: 'per 10 ms while awake; sleeps to zero after idle_seconds',
      binding: service.binding, class_name: service.class_name, application: service.application,
      build: imageBuild(doc),
      instance_type: service.instance_type, max_instances: service.max_instances, port: service.port,
      start_argv: ['node', `${GATEWAY_FOLDER}/serve.mjs`, `${GATEWAY_FOLDER}/config.json`],
      env: { PORT: String(service.port) },
      ready: { path: '/', expect_status: 200 },
      idle_seconds: service.idle_seconds, save_after_write_seconds: service.save_after_write_seconds,
    },
    { kind: 'hosted-site', id: service.site_id, service: service.id, label: service.label, host: service.host, url: `https://${service.host}` },
  ];
}

export function liveSourcesFor(doc) {
  return doc.apps.map(app => ({
    id: app.name, kind: 'mcp', name: app.label, url: appUrl(doc, app),
    licence: app.licence ?? doc.licence, licence_class: doc.licence_class, maker: app.maker ?? doc.maker, page: app.page ?? app.repo, about: app.about,
  }));
}
