// parts/stdio-mcp-gateway/do-work/serve.mjs
//
// Runs the gateway (./gateway.mjs) as a web server: `node serve.mjs <config.json>`. The config is DATA:
//   { "port": 8080, "apps": { "<name>": { "cli": "/usr/local/bin/<name>-cli", "args": ["mcp"] } },
//     "max_sessions", "session_idle_seconds", "session_max_seconds", "request_timeout_seconds", "queue_seconds" }
// In a hosted container the config is written next to this file when the image is built
// (src/hosted-mcp-apps.mjs gatewayConfig). Nothing here names an app.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createGateway } from './gateway.mjs';

const configPath = process.argv[2] ?? process.env.GATEWAY_CONFIG;
if (!configPath) throw new Error('usage: node serve.mjs <config.json>');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const seconds = (value, fallback) => (Number(value) > 0 ? Number(value) * 1000 : fallback);

const gateway = createGateway({
  apps: config.apps,
  maxSessions: config.max_sessions ?? 16,
  idleMs: seconds(config.session_idle_seconds, 120_000),
  maxAgeMs: seconds(config.session_max_seconds, 1_800_000),
  requestTimeoutMs: seconds(config.request_timeout_seconds, 120_000),
  queueMs: seconds(config.queue_seconds, 15_000),
  log: line => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
});
const server = createServer((request, response) => { void gateway.handle(request, response); });
server.requestTimeout = 0;
server.headersTimeout = 30_000;
const port = Number(process.env.PORT ?? config.port ?? 8080);
server.listen(port, '0.0.0.0', () => process.stdout.write(`stdio-mcp-gateway on ${port}: ${Object.keys(config.apps).join(', ')}\n`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { gateway.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); });
