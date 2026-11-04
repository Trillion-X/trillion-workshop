// PORTED FROM: bitfield-packages/packages/chat/do-work/create-idea-from-chat.ts @ e99ac5976
import { sendRequestToBitfieldTarget } from '#workspace-records';

const CREATE_IDEA_FROM_CHAT_ACTION = 'action:create-idea';

export interface CreateIdeaFromChatInput {
  content: string;
  project: string;
  now?: Date;
  ideaId?: string;
  source?: string;
  tags?: string[];
}

function ideaDateString(now: Date): string {
  return now.toISOString().split('T')[0];
}

function createIdeaSlug(title: string, now: Date): string {
  const date = ideaDateString(now);
  const titleSlug = title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  return `${date}-${titleSlug}`;
}

export function buildCreateIdeaFromChatInput(input: CreateIdeaFromChatInput): Record<string, unknown> {
  const now = input.now ?? new Date();
  const title = input.content.split('\n')[0].slice(0, 100);

  return {
    idea_id: input.ideaId ?? `idea:${crypto.randomUUID()}`,
    slug: createIdeaSlug(title, now),
    title,
    date: ideaDateString(now),
    source: input.source ?? 'chat',
    project: input.project,
    content: input.content,
    related_tasks: [],
    tags: input.tags ?? [],
  };
}

export async function createIdeaFromChat(input: CreateIdeaFromChatInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: 'slot::workflow',
    payload: {
      operation: 'execute_definition',
      definition_id: CREATE_IDEA_FROM_CHAT_ACTION,
      include_steps: false,
      include_output: false,
      input: buildCreateIdeaFromChatInput(input),
    },
  });
}
