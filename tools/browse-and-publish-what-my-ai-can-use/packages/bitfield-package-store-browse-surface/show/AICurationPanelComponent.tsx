import React from "react";
import { sendRequestToBitfieldTarget } from "@bitfield/runtime-kit";
import { buildEngineReadCurrentRequestFromLabels, decodeEngineReadCurrentReply } from "@bitfield/runtime-kit/protocol";
import { Button } from "@/packages/ui/show/button";
import { Card } from "@/packages/ui/show/card";
import { Text } from "@/packages/ui/show/text";
import { Badge } from "@/packages/ui/show/badge";
import { Container } from "@/packages/ui/show/container";

interface CuratedItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

type CurationState =
  | { kind: "loading" }
  | { kind: "done"; items: readonly CuratedItem[] }
  | { kind: "error"; message: string };

async function readProducerResult(
  requestId: string,
): Promise<CurationState> {
  const resultAddress = `package::ai-records-producer::result::${requestId}`;

  try {
    // Read the result record from the producer (written at label-hash address)
    const request = buildEngineReadCurrentRequestFromLabels("runtime-partition", resultAddress, {
      addressMode: "label-hash",
    });
    const reply = await sendRequestToBitfieldTarget(request);

    const bytes =
      reply instanceof Uint8Array
        ? reply
        : reply instanceof ArrayBuffer
          ? new Uint8Array(reply)
          : null;

    if (!bytes) {
      return { kind: "loading" };
    }

    const current = decodeEngineReadCurrentReply(bytes);
    if (!current.found || !current.payload) {
      return { kind: "loading" };
    }

    const text = new TextDecoder().decode(current.payload);
    const result = JSON.parse(text);

    // Check for error in the result record
    if (result.error_code || result.error_message) {
      return {
        kind: "error",
        message: result.error_message || "Failed to curate packages",
      };
    }

    // Parse the items from the result
    const items: CuratedItem[] = [];
    if (Array.isArray(result.items)) {
      for (const item of result.items) {
        if (item && typeof item === "object") {
          items.push({
            id: item.id || `item-${Math.random()}`,
            name: item.name || item.text || "Unknown package",
            description: item.description || item.text,
          });
        }
      }
    }

    if (items.length === 0 && !result.error_code) {
      // Still loading if no items yet and no error
      return { kind: "loading" };
    }

    return { kind: "done", items };
  } catch (error) {
    return { kind: "error", message: "Failed to load curated packages" };
  }
}

interface CatalogPackageForCuration {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly price: string;
}

function buildGroundedInstruction(
  query: string,
  packages: readonly CatalogPackageForCuration[],
): string {
  if (packages.length === 0) {
    return `Curate packages for: "${query}"`;
  }
  const roster = packages
    .map((entry) => `- id: ${entry.id} | name: ${entry.name} | does: ${entry.summary} | price: ${entry.price}`)
    .join("\n");
  return [
    "You are the Bitfield package store curator.",
    `The person described their software stack or goal: "${query}".`,
    "Choose ONLY packages from the roster below that together replace that stack or build what they asked for.",
    "For each chosen package, say in one line what tool or job it replaces.",
    "Never invent a package that is not in the roster. Return a JSON object with an items array; each item has id, name, and description (the what-it-replaces line).",
    "",
    "ROSTER:",
    roster,
  ].join("\n");
}

export function AICurationPanelComponent({
  curatingQuery,
  catalogPackages,
  onBack,
  onSelectPackages,
}: {
  curatingQuery: string;
  catalogPackages?: readonly CatalogPackageForCuration[];
  onBack: () => void;
  onSelectPackages?: (packageIds: string[]) => void;
}) {
  const [state, setState] = React.useState<CurationState>({ kind: "loading" });
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [requestId, setRequestId] = React.useState<string>("");

  React.useEffect(() => {
    const submitAndPoll = async () => {
      const newRequestId = `curation-${Date.now()}`;
      setRequestId(newRequestId);

      try {
        // Submit the producer action
        await sendRequestToBitfieldTarget({
          target: "slot::workflow",
          payload: {
            operation: "execute_definition",
            include_output: false,
            definition_id: "action:run-ai-records-production",
            input: {
              request_id: newRequestId,
              instruction_text: buildGroundedInstruction(curatingQuery, catalogPackages ?? []),
              output_kind: "message",
              model: "",
              wrap_instruction_ref: "",
              target_group_ref: "package-store",
              partition_key: "runtime-partition",
              agent_ref: "",
            },
          },
        });
      } catch (error) {
        // Dispatch itself failed (e.g. the curation service is not available on
        // this carrier). This is infrastructure the user cannot act on, so log
        // the technical detail but show the user plain domain language — never
        // leak raw internal errors like "unknown target: slot::workflow" (L114).
        console.error("AI curation submit failed:", error);
        setState({
          kind: "error",
          message: "AI curation isn't available right now.",
        });
      }
    };

    void submitAndPoll();
  }, [curatingQuery]);

  // Poll the producer result
  React.useEffect(() => {
    if (!requestId) return;
    if (state.kind !== "loading") return;

    const pollInterval = setInterval(async () => {
      const result = await readProducerResult(requestId);
      setState(result);
    }, 1000);

    return () => clearInterval(pollInterval);
  }, [requestId, state.kind]);

  const handleSelectAll = () => {
    if (state.kind === "done") {
      const allIds = new Set(state.items.map((item) => item.id));
      setSelectedIds(allIds);
    }
  };

  const handleToggleItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleDownloadSelected = () => {
    if (onSelectPackages) {
      onSelectPackages(Array.from(selectedIds));
    }
  };

  return (
    <Card>
      <Container layout="vertical" gap="lg" padding="lg">
        <Container layout="horizontal" gap="md">
          <Text variant="heading-lg">Curating for: {curatingQuery}</Text>
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back
          </Button>
        </Container>

        {state.kind === "loading" && (
          <Container layout="horizontal" gap="sm">
            <Badge variant="secondary">Curating...</Badge>
          </Container>
        )}

        {state.kind === "error" && (
          <Badge variant="destructive">{state.message}</Badge>
        )}

        {state.kind === "done" && state.items.length === 0 && (
          <Text variant="body-xs" color="muted">
            No packages found for your query.
          </Text>
        )}

        {state.kind === "done" && state.items.length > 0 && (
          <Container layout="vertical" gap="md">
            <Container layout="horizontal" gap="sm">
              <Button variant="secondary" size="sm" onClick={handleSelectAll}>
                Select all
              </Button>
              <Badge variant="secondary">
                {selectedIds.size} of {state.items.length} selected
              </Badge>
            </Container>

            <Container layout="vertical" gap="sm">
              {state.items.map((item) => (
                <Card key={item.id}>
                  <Container
                    layout="horizontal"
                    gap="md"
                    padding="md"
                    onClick={() => handleToggleItem(item.id)}
                  >
                    <Badge
                      variant={selectedIds.has(item.id) ? "primary" : "secondary"}
                    >
                      {selectedIds.has(item.id) ? "✓" : "○"}
                    </Badge>
                    <Container layout="vertical" gap="xs">
                      <Text variant="body" weight="medium">
                        {item.name}
                      </Text>
                      {item.description && (
                        <Text variant="body-xs" color="muted">
                          {item.description}
                        </Text>
                      )}
                    </Container>
                  </Container>
                </Card>
              ))}
            </Container>

            {selectedIds.size > 0 && (
              <Container layout="horizontal" gap="md">
                <Button
                  variant="primary"
                  size="md"
                  onClick={handleDownloadSelected}
                >
                  Download selected ({selectedIds.size})
                </Button>
                <Button variant="secondary" size="md" onClick={onBack}>
                  Cancel
                </Button>
              </Container>
            )}
          </Container>
        )}
      </Container>
    </Card>
  );
}
