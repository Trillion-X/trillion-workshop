// PORTED FROM: bitfield-packages/packages/conversations/read-data/build-conversation-projections.ts @ e99ac5976
import {
  CONVERSATION_ACTION_SET_PROJECTION,
  CONVERSATION_MESSAGE_PAGE_PROJECTION,
  CONVERSATION_RECORD_LIST_PROJECTION,
  decodeGenericMessagePageProjection,
  decodeGenericRecordProjection,
  type GenericMessagePageProjection,
  type GenericRecordProjection,
  type JsonRecord,
  type ProjectionMessage,
} from './record-projection';

type Row = JsonRecord;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((entry): entry is Row => {
    return entry != null && typeof entry === 'object' && !Array.isArray(entry);
  }) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function optionalText(value: unknown): string | undefined {
  const result = text(value);
  return result || undefined;
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function sequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function compareTurns(left: Row, right: Row): number {
  const leftSequence = sequence(left.sequence) ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = sequence(right.sequence) ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  return text(left.turn_ref).localeCompare(text(right.turn_ref));
}

function conversationRef(row: Row): string {
  return text(row.conversation_ref);
}

function turnRef(row: Row): string {
  return text(row.turn_ref);
}

function projectionMessage(row: Row): ProjectionMessage {
  const ref = turnRef(row);
  return {
    id: ref,
    recordRef: ref,
    text: text(row.content),
    role: optionalText(row.role),
    speakerRef: optionalText(row.speaker_ref),
    authorRef: optionalText(row.author_ref),
    addressedParticipantRefs: textArray(row.addressed_participant_refs),
    deliveryReceiptRefs: textArray(row.delivery_receipt_refs),
    parentTurnRef: optionalText(row.parent_turn_ref),
    correlationRefs: textArray(row.correlation_refs),
    effectReceiptRef: optionalText(row.effect_receipt_ref),
    sequence: sequence(row.sequence),
    authorLabel: optionalText(row.author_label),
    occurredAt: optionalText(row.occurred_at),
    sourceRefs: textArray(row.source_refs),
    facets: {
      addressedParticipants: {
        key: 'addressed-participants',
        refs: textArray(row.addressed_participant_refs),
      },
      deliveryReceipts: {
        key: 'delivery-receipts',
        refs: textArray(row.delivery_receipt_refs),
      },
    },
    provenance: {
      author_ref: row.author_ref ?? null,
      source_refs: textArray(row.source_refs),
    },
  };
}

export function buildConversationProjections(
  rawConversations: unknown,
  rawTurns: unknown,
  rawMessagePages: unknown,
): {
  recordList: GenericRecordProjection;
  messagePages: GenericMessagePageProjection;
} {
  const conversationRows = rows(rawConversations);
  const turnRowsByConversation = new Map<string, Row[]>();
  for (const row of rows(rawTurns)) {
    const ref = conversationRef(row);
    if (!ref) continue;
    const existing = turnRowsByConversation.get(ref) ?? [];
    existing.push(row);
    turnRowsByConversation.set(ref, existing);
  }

  const pageRowsByConversation = new Map<string, Row[]>();
  for (const row of rows(rawMessagePages)) {
    const ref = conversationRef(row);
    if (!ref) continue;
    const existing = pageRowsByConversation.get(ref) ?? [];
    existing.push(row);
    pageRowsByConversation.set(ref, existing);
  }

  const pages: GenericMessagePageProjection['pages'] = {};
  const records = conversationRows.map((row) => {
    const ref = conversationRef(row);
    const turns = [...(turnRowsByConversation.get(ref) ?? [])].sort(compareTurns);
    const pageRows = pageRowsByConversation.get(ref) ?? [];
    const pageRef = text(row.message_page_ref)
      || text(pageRows.at(-1)?.message_page_ref)
      || ref;
    const turnsByRef = new Map<string, Row>();
    for (const turn of turns) {
      const id = turnRef(turn);
      if (!id) throw new Error('conversation-projection:missing-turn-reference');
      const prior = turnsByRef.get(id);
      if (prior && JSON.stringify(projectionMessage(prior)) !== JSON.stringify(projectionMessage(turn))) {
        throw new Error('conversation-projection:conflicting-turn-replay');
      }
      turnsByRef.set(id, turn);
    }
    const sequenceOwners = new Map<number, string>();
    for (const [id, turn] of turnsByRef) {
      const order = sequence(turn.sequence);
      if (order === undefined || order < 0) throw new Error('conversation-projection:invalid-turn-sequence');
      const prior = sequenceOwners.get(order);
      if (prior && prior !== id) throw new Error('conversation-projection:conflicting-turn-sequence');
      sequenceOwners.set(order, id);
    }
    const projectionPageRows: Row[] = pageRows.length ? pageRows : [{ message_page_ref: pageRef }];
    for (const page of projectionPageRows) {
      const currentPageRef = text(page.message_page_ref);
      if (!currentPageRef) throw new Error('conversation-projection:missing-page-reference');
      if (pages[currentPageRef] && pages[currentPageRef].recordRef !== ref) {
        throw new Error('conversation-projection:page-conversation-conflict');
      }
      if (page.message_refs !== undefined && (!Array.isArray(page.message_refs)
        || page.message_refs.some((id) => typeof id !== 'string' || id.length === 0))) {
        throw new Error('conversation-projection:invalid-page-membership');
      }
      const selected = Array.isArray(page.message_refs)
        ? textArray(page.message_refs).map((id) => {
          const turn = turnsByRef.get(id);
          if (!turn) throw new Error('conversation-projection:page-turn-unavailable');
          return turn;
        })
        : [...turnsByRef.values()];
      const selectedIds = new Set<string>();
      for (let index = 0; index < selected.length; index += 1) {
        const id = turnRef(selected[index]);
        if (selectedIds.has(id) || (index > 0 && compareTurns(selected[index - 1], selected[index]) >= 0)) {
          throw new Error('conversation-projection:invalid-page-order');
        }
        selectedIds.add(id);
      }
      const projectedPage = {
        pageRef: currentPageRef,
        recordRef: ref,
        nextCursorRef: optionalText(page.next_cursor_ref),
        messages: selected.map(projectionMessage),
        provenance: {
          conversation_ref: ref,
          turn_count: selected.length,
          source: 'conversations.addressed-exchange-owner-feeds',
        },
      };
      if (pages[currentPageRef] && JSON.stringify(pages[currentPageRef]) !== JSON.stringify(projectedPage)) {
        throw new Error('conversation-projection:conflicting-page-replay');
      }
      pages[currentPageRef] = projectedPage;
    }

    const participantRefs = textArray(row.participant_refs);
    const wayRefs = textArray(row.way_refs);
    const serviceConnectionRefs = textArray(row.service_connection_refs);
    const sourceRefs = textArray(row.source_refs);
    return {
      recordRef: ref,
      primaryText: text(row.title) || ref,
      secondaryText: text(row.last_message_preview),
      sortKey: text(row.last_activity_at) || text(row.updated_at) || text(row.created_at) || ref,
      fields: {
        ...row,
        participant_refs: participantRefs,
        way_refs: wayRefs,
        service_connection_refs: serviceConnectionRefs,
        source_refs: sourceRefs,
      },
      relationships: {
        participant_refs: participantRefs,
        way_refs: wayRefs,
        service_connection_refs: serviceConnectionRefs,
        proof_refs: textArray(row.proof_refs),
        route_refs: textArray(row.route_refs),
      },
      facets: {
        participants: {
          key: 'participants',
          label: `${participantRefs.length} participant${participantRefs.length === 1 ? '' : 's'}`,
          refs: participantRefs,
        },
        ways: {
          key: 'ways',
          label: `${wayRefs.length} way${wayRefs.length === 1 ? '' : 's'}`,
          refs: wayRefs,
        },
      },
      actionsRef: CONVERSATION_ACTION_SET_PROJECTION,
      pageRef,
      provenance: {
        conversation_ref: ref,
        source_refs: sourceRefs,
      },
    };
  }).filter((record) => record.recordRef.length > 0);

  const cursor = Object.values(pages)
    .flatMap((page) => page.messages)
    .map((message) => message.id)
    .sort((left, right) => left.localeCompare(right))
    .at(-1) ?? '';

  const provenance = {
    conversations_feed: 'conversations.addressed-exchange-conversations',
    turns_feed: 'conversations.addressed-exchange-turns',
    message_pages_feed: 'conversations.addressed-exchange-message-pages',
  };
  return {
    recordList: decodeGenericRecordProjection({
      projection_id: CONVERSATION_RECORD_LIST_PROJECTION,
      generation: 'canonical-addressed-exchange-feeds',
      cursor,
      state: 'ready',
      records,
      actions: [],
      provenance,
    }),
    messagePages: decodeGenericMessagePageProjection({
      projection_id: CONVERSATION_MESSAGE_PAGE_PROJECTION,
      generation: 'canonical-addressed-exchange-feeds',
      cursor,
      state: 'ready',
      pages,
      provenance,
    }),
  };
}
