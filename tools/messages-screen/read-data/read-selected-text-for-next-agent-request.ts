// PORTED FROM: bitfield-packages/packages/chat/read-data/read-selected-text-for-next-agent-request.ts @ e99ac5976
export interface ChatSelectedTextEntityRef {
  entity_id: string;
  entity_type: string;
  display_label: string;
}

export interface ChatSelectedTextForNextAgentRequest {
  source: 'file' | 'note';
  identifier: string;
  title: string;
  selectedText: string;
  startLine?: number;
  endLine?: number;
  fullContent?: string;
  entityRefs?: ChatSelectedTextEntityRef[];
}

interface SelectedTextFeedRow {
  property_id?: unknown;
  value?: unknown;
}

function asEntityRefs(value: unknown): ChatSelectedTextEntityRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs: ChatSelectedTextEntityRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    if (
      typeof row.entity_id === 'string'
      && typeof row.entity_type === 'string'
      && typeof row.display_label === 'string'
    ) {
      refs.push({
        entity_id: row.entity_id,
        entity_type: row.entity_type,
        display_label: row.display_label,
      });
    }
  }
  return refs.length > 0 ? refs : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function decodeSelection(value: unknown): ChatSelectedTextForNextAgentRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.source !== 'file' && row.source !== 'note') return null;
  if (typeof row.identifier !== 'string') return null;
  if (typeof row.title !== 'string') return null;
  if (typeof row.selectedText !== 'string' || row.selectedText.length === 0) return null;

  return {
    source: row.source,
    identifier: row.identifier,
    title: row.title,
    selectedText: row.selectedText,
    startLine: asOptionalNumber(row.startLine),
    endLine: asOptionalNumber(row.endLine),
    fullContent: typeof row.fullContent === 'string' ? row.fullContent : undefined,
    entityRefs: asEntityRefs(row.entityRefs),
  };
}

export function decodeChatSelectedTextForNextAgentRequestFeed(
  raw: unknown,
): ChatSelectedTextForNextAgentRequest | null {
  const rows = Array.isArray(raw) ? raw : [];
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as SelectedTextFeedRow;
    if (row.property_id === 'prop:selected_text_for_next_agent_request:value') {
      return decodeSelection(row.value);
    }
  }
  return null;
}
