// packages/service-connections/read-data/ask-a-runtime-provider-which-images-it-holds.mjs
//
// Ask whatever fills a runtime-provider role on THIS machine which images it
// holds, and what each one's immutable digest is.
//
// WHY THIS IS A READER AND NOT A COMMAND. A process-admission policy names a
// runtime by an immutable digest, never by a tag, because a tag is a moving
// name and the whole point of the field is that the bytes cannot change under
// the policy. But a digest is a fact somebody else owns and changes on their
// own schedule, so it is READ from its source, never typed in from memory
// (L216). This is that read.
//
// It names no vendor, no image, no product and no path. The role is the
// caller's word, the socket comes from the machine's own connection registry,
// and the answer is whatever that provider says it holds. Point it at a role
// filled by something else entirely and it still does a recognisable job.
//
// Usage:
//   node <pkg>/read-data/ask-a-runtime-provider-which-images-it-holds.mjs \
//     --role <connection-role-label> [--named <substring>]
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WHERE_THIS_MACHINE_KEEPS_ITS_PROVIDER_CONNECTIONS = path.join(
  homedir(),
  ".bitfield",
  "runtime-kit",
  "apps-this-computer-can-open",
  "process-provider-connections.json",
);

function argumentValue(flag) {
  const at = process.argv.indexOf(flag);
  return at >= 0 && at < process.argv.length - 1 ? process.argv[at + 1] : null;
}

/// The machine says which of its connections fills a role and where that one
/// is. The caller names only the role, exactly as a package note does, so no
/// path to anything outside this machine is ever written down by a caller.
export function socketThisMachineAnswersOn(role) {
  const held = JSON.parse(
    readFileSync(WHERE_THIS_MACHINE_KEEPS_ITS_PROVIDER_CONNECTIONS, "utf8"),
  );
  const known = held.connections ?? {};
  const found = known[role];
  if (!found) {
    throw new Error(
      `this machine has no connection filling the role ${role}. It fills: ` +
        (Object.keys(known).sort().join(", ") || "nothing"),
    );
  }
  return found;
}

export function admissionInspectionForHeldImage(listed, described) {
  if (
    typeof listed?.Id !== "string" ||
    typeof described?.Id !== "string" ||
    listed.Id !== described.Id
  ) {
    throw new Error("the listed image and its inspection do not have the same config identity");
  }
  return {
    Id: described.Id,
    RepoDigests: Array.isArray(described.RepoDigests)
      ? described.RepoDigests
      : Array.isArray(listed.RepoDigests)
        ? listed.RepoDigests
        : [],
    RootFS: {
      Type: described.RootFS?.Type ?? null,
      Layers: Array.isArray(described.RootFS?.Layers)
        ? described.RootFS.Layers
        : [],
    },
  };
}

function askOverUnixSocket(socketPath, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, path: requestPath, method: "GET" },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `the provider answered ${response.statusCode} for ${requestPath}: ${text}`,
              ),
            );
            return;
          }
          resolve(JSON.parse(text));
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export async function imagesHeldByRole(role, named) {
  const connection = socketThisMachineAnswersOn(role);
  const held = await askOverUnixSocket(connection.socket_path, "/images/json");
  const rows = [];
  for (const image of held) {
    const tags = image.RepoTags ?? [];
    const digests = image.RepoDigests ?? [];
    if (named && !tags.concat(digests).some((label) => label.includes(named))) {
      continue;
    }
    // A policy that names an image also has to name the program inside it to
    // run, and that is a fact about the image rather than about the caller, so
    // it is read from the same place the digest is read from.
    const described = await askOverUnixSocket(
      connection.socket_path,
      `/images/${encodeURIComponent(image.Id)}/json`,
    );
    rows.push({
      tags,
      digests,
      size_bytes: image.Size,
      admission_inspection: admissionInspectionForHeldImage(image, described),
      entrypoint: described.Config?.Entrypoint ?? null,
      default_command: described.Config?.Cmd ?? null,
      path_inside: (described.Config?.Env ?? [])
        .map((entry) => String(entry))
        .find((entry) => entry.startsWith("PATH=")),
    });
  }
  return rows;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(new URL(import.meta.url)))
) {
  const role = argumentValue("--role");
  if (!role) {
    console.error("--role is required");
    process.exit(2);
  }
  imagesHeldByRole(role, argumentValue("--named"))
    .then((rows) => console.log(JSON.stringify(rows, null, 2)))
    .catch((error) => {
      console.error(String(error.message ?? error));
      process.exit(1);
    });
}