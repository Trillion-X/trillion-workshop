#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
import {
  executeDefinition,
  findCurrentRecords,
  readCurrentRecord,
  startRunningAppSession,
} from "../read-data/find-the-running-app-and-send-requests-to-it.mjs";

const statusFile = argumentValue("status-file") ?? process.env.RUNNING_APP_STATUS_FILE;
const appId = argumentValue("app-id") ?? process.env.RUNNING_APP_APP_ID;
const declaredEngineConnections = loadDeclaredEngineConnections();
const sessionsByConnectionId = new Map();

const tools = [
  {
    name: "list_running_app_actions",
    description: "List action descriptors from the selected running app or a declared engine connection",
      inputSchema: {
        type: "object",
        properties: {
          connectionId: {
            type: "string",
            description: "Optional engine connection id declared in package DATA; agents never supply URLs",
          },
          limit: {
            type: "number",
            description: "Maximum action rows to return; default 1000. A bounded page larger than the app's action count is the calibrated-absence requirement",
          },
        },
        required: [],
      },
  },
  {
    name: "find_running_app_records",
    description: "Find current published records in the selected running app by record kind",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Optional engine connection id declared in package DATA; agents never supply URLs",
        },
        kind: { type: "string", description: "Record kind, for example content-generation.recipe" },
        limit: { type: "number", description: "Maximum rows to return", default: 50 },
      },
      required: ["kind"],
    },
  },
  {
    name: "call_running_app_action",
    description: "Execute one declared action on the selected running app",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Optional engine connection id declared in package DATA; agents never supply URLs",
        },
        definitionId: {
          type: "string",
          description: "Declared action definition id from list_running_app_actions",
        },
        input: {
          type: "object",
          description: "Action input declared by the selected definition",
          additionalProperties: true,
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          maximum: 600000,
          description: "Optional bounded transport timeout in milliseconds; omitted calls retain the package default",
        },
      },
      required: ["definitionId", "input"],
    },
  },
  {
    name: "read_running_app_record",
    description: "Read one current published record by exact label address; calibrated absence requires found=false from this read, never an empty list",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: {
          type: "string",
          description: "Optional engine connection id declared in package DATA; agents never supply URLs",
        },
        partition: { type: "string", description: "Optional partition label for a declared remote connection; omit for the selected app's serving partition" },
        address: { type: "string", description: "Exact record address label" },
        addressMode: { type: "string", description: "Address mode; default identity_text" },
      },
      required: ["address"],
    },
  },
];

const reader = readline.createInterface({ input: process.stdin, terminal: false });
reader.on("line", async (line) => {
  let message = null;
  try {
    message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "send-requests-to-an-engine", version: "1.0.0" },
      });
    } else if (message.method === "tools/list") {
      reply(message, { tools });
    } else if (message.method === "tools/call") {
      const name = message.params?.name;
      const input = message.params?.arguments ?? {};
      if (name === "list_running_app_actions") {
        const records = await selectedRecords("action", Number(input.limit || 1000), input.connectionId);
        const actions = records
          .filter((record) => record?.id?.startsWith("action:"))
          .map((record) => ({
            id: record.id,
            name: record.name || "",
            description: record.description || "",
            input_schema: record.input_schema || null,
            is_active: record.is_active !== false,
          }));
        reply(message, { content: [{ type: "text", text: JSON.stringify(actions, null, 2) }] });
      } else if (name === "find_running_app_records") {
        const records = await selectedRecords(
          String(input.kind || ""),
          Number(input.limit || 50),
          input.connectionId,
        );
        reply(message, { content: [{ type: "text", text: JSON.stringify(records, null, 2) }] });
      } else if (name === "call_running_app_action") {
        const definitionId = String(input.definitionId || "").trim();
        const connectionId = typeof input.connectionId === "string" ? input.connectionId.trim() : "";
        if (!definitionId) {
          reply(message, { content: [{ type: "text", text: "definitionId is required" }], isError: true });
          return;
        }
        if (connectionId && !declaredEngineConnections.has(connectionId)) {
          reply(message, {
            content: [{ type: "text", text: `Unknown engine connection id: ${connectionId}` }],
            isError: true,
          });
          return;
        }
        if (input.input === null || typeof input.input !== "object" || Array.isArray(input.input)) {
          reply(message, { content: [{ type: "text", text: "input must be an object" }], isError: true });
          return;
        }
        const timeoutMs = optionalBoundedTimeoutMs(input.timeoutMs);
        const selectedSession = await sessionFor(input.connectionId);
        const result = await executeDefinition(selectedSession, definitionId, input.input, {
          includeOutput: true,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        });
        reply(message, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } else if (name === "read_running_app_record") {
        const partition = String(input.partition || "").trim();
        const address = String(input.address || "").trim();
        if (!address) {
          reply(message, { content: [{ type: "text", text: "address is required" }], isError: true });
          return;
        }
        const addressMode = typeof input.addressMode === "string" && input.addressMode.trim()
          ? input.addressMode.trim()
          : "identity_text";
        const selectedSession = await sessionFor(input.connectionId);
        const record = await readCurrentRecord(selectedSession, partition, address, { addressMode });
        reply(message, { content: [{ type: "text", text: JSON.stringify(record, null, 2) }] });
      } else {
        reply(message, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
      }
    }
  } catch (error) {
    if (message?.id != null) {
      reply(message, undefined, { code: -32603, message: error.message });
    }
  }
});

async function selectedRecords(kind, limit, connectionId) {
  const selectedSession = await sessionFor(connectionId);
  return findCurrentRecords(selectedSession, kind, { limit });
}

async function sessionFor(connectionId) {
  const id = typeof connectionId === "string" ? connectionId.trim() : "";
  if (!id) {
    // The owner may replace the socket and command-list basis while this MCP
    // process stays alive. Resolve both before each request. Never retry an
    // action after a transport error: its effects may already have happened.
    return startRunningAppSession({ statusFile, appId });
  }
  if (sessionsByConnectionId.has(id)) return sessionsByConnectionId.get(id);
  const connection = declaredEngineConnections.get(id);
  if (!connection) throw new Error(`Unknown engine connection id: ${id}`);
  const created = await startRunningAppSession({ url: connection.url });
  sessionsByConnectionId.set(id, created);
  return created;
}

function loadDeclaredEngineConnections() {
  const sourcePath = new URL("../engine-connections.json", import.meta.url);
  const parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const rows = Array.isArray(parsed?.connections) ? parsed.connections : [];
  const connections = new Map();
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id.trim() : "";
    const url = typeof row?.url === "string" ? row.url.trim() : "";
    if (!id || !url || !/^https?:\/\//i.test(url)) continue;
    connections.set(id, { id, url, description: row.description || "" });
  }
  return connections;
}

function optionalBoundedTimeoutMs(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 600000) {
    throw new Error("timeoutMs must be an integer from 1 through 600000");
  }
  return value;
}

function reply(message, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result, error }) + "\n");
}

function argumentValue(name) {
  const prefix = `--${name}=`;
  const exact = `--${name}`;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument.startsWith(prefix)) return argument.slice(prefix.length);
    if (argument === exact) return process.argv[index + 1];
  }
  return undefined;
}
