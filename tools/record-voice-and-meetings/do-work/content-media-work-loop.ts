import { sendRequestToBitfieldTarget } from '#workspace-records';
const WORKFLOW_TARGET = 'slot::workflow';
const LOCAL_FILE_SELECTION_TARGET = 'local-files.choose';
const MATERIALIZE_ARTIFACT_TARGET = 'content-media-evidence.materialize-artifact';
const RELATION_ACTION_DEFINITION_ID = 'action:content-media-evidence:create-relation';
const RELATION_ACTION_DESCRIPTOR_ID = 'create-relation';
const RELATION_BACKEND_DESCRIPTOR_ID = 'record-action-session-projection:content-media-evidence:relations';

export type ChooseContentMediaFileOptions = {
  readonly prompt?: string;
  readonly multiple?: boolean;
  readonly allowedContentPrefixes?: readonly string[];
};

export const CONTENT_MEDIA_AUDIO_EXTENSIONS = [
  'aac',
  'aif',
  'aiff',
  'flac',
  'm4a',
  'mp3',
  'ogg',
  'wav',
];

export const CONTENT_MEDIA_VIDEO_EXTENSIONS = [
  'mov',
  'mp4',
  'mpeg',
  'mpg',
  'webm',
];

export const CONTENT_MEDIA_IMAGE_EXTENSIONS = [
  'avif',
  'gif',
  'heic',
  'heif',
  'jpeg',
  'jpg',
  'png',
  'webp',
];

export type ContentMediaArtifactRef = {
  kind: 'content-media.materialized-relation/v1';
  relation_ref: string;
  integrity_hash: string;
  media_type: string;
  byte_length: number;
  display_name: string;
  provenance: Record<string, unknown>;
};

export type ContentMediaSourceRef = {
  role: string;
  media_type: string;
  display_name: string;
  artifact_ref: ContentMediaArtifactRef;
};

export type StageContentMediaFileInput = {
  packageName: string;
  file: File | LocalContentMediaFile;
  sourceId?: string;
  role?: string;
  pathLabels?: readonly string[];
};

export type SubmitWorkflowActionInput = {
  definitionId: string;
  input: unknown;
  includeSteps?: boolean;
  includeOutput?: boolean;
};

export type ContentMediaRelationInput = {
  relationId?: string;
  sourceRef: unknown;
  targetRef: unknown;
  roleRef: unknown;
  contextRef?: unknown;
  receiptRef?: unknown;
  stateRef?: unknown;
  errorRef?: unknown;
  idempotencyRef?: string;
};

export type ContentMediaRelationWorkflowRequest = {
  target: typeof WORKFLOW_TARGET;
  payload: {
    operation: 'execute_definition';
    definition_id: typeof RELATION_ACTION_DEFINITION_ID;
    include_steps: false;
    include_output: false;
    input: Record<string, unknown>;
  };
};

function safeSegment(value: string): string {
  const segment = value.trim().replace(/[^a-zA-Z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!segment) throw new Error('A source segment is required.');
  return segment;
}

export function createContentMediaWorkId(prefix: string): string {
  return `${safeSegment(prefix)}:${crypto.randomUUID()}`;
}

export function buildCreateContentMediaRelationRequest(
  input: ContentMediaRelationInput,
): ContentMediaRelationWorkflowRequest {
  const relationId = input.relationId ?? createContentMediaWorkId('relation');
  return {
    target: WORKFLOW_TARGET,
    payload: {
      operation: 'execute_definition',
      definition_id: RELATION_ACTION_DEFINITION_ID,
      include_steps: false,
      include_output: false,
      input: {
        relation_id: relationId,
        record_id: relationId,
        source_ref: input.sourceRef,
        target_ref: input.targetRef,
        role_ref: input.roleRef,
        context_ref: input.contextRef ?? null,
        receipt_ref: input.receiptRef ?? null,
        state_ref: input.stateRef ?? null,
        error_ref: input.errorRef ?? null,
        idempotency_ref: input.idempotencyRef ?? relationId,
        action_descriptor_id: RELATION_ACTION_DESCRIPTOR_ID,
        backend_descriptor_id: RELATION_BACKEND_DESCRIPTOR_ID,
      },
    },
  };
}

export function contentMediaRoleForFile(file: File | LocalContentMediaFile): string {
  const family = file.type.split('/')[0]?.trim();
  return family ? `stored-${safeSegment(family).toLowerCase()}` : 'stored-file';
}

export function contentMediaTypeForFile(file: File | LocalContentMediaFile): string {
  return file.type || 'application/octet-stream';
}

export type LocalContentMediaFile = {
  name: string;
  type: string;
  size: number;
  localPath: string;
};

type OwnerChosenFile = {
  readonly name?: unknown;
  readonly contentType?: unknown;
  readonly byteLength?: unknown;
  readonly path?: unknown;
  readonly bytes?: unknown;
};

function ownerPayload(reply: unknown): unknown {
  return reply && typeof reply === 'object' && 'payload' in reply
    ? (reply as { payload?: unknown }).payload
    : reply;
}

export function contentMediaFileFromLocalFile(file: OwnerChosenFile): File | LocalContentMediaFile {
  const name = typeof file.name === 'string' ? file.name : 'artifact.bin';
  const contentType = typeof file.contentType === 'string' ? file.contentType : 'application/octet-stream';
  const byteLength = typeof file.byteLength === 'number' ? file.byteLength : 0;
  if (!(file.bytes instanceof Uint8Array) && typeof file.path === 'string' && file.path) {
    return {
      name,
      type: contentType,
      size: byteLength,
      localPath: file.path,
    };
  }
  if (!(file.bytes instanceof Uint8Array)) {
    throw new Error(`Selected local file has no readable source: ${name}`);
  }
  return new File([file.bytes.slice()], name, {
    type: contentType,
  });
}

export async function chooseContentMediaFiles(options: ChooseContentMediaFileOptions = {}): Promise<Array<File | LocalContentMediaFile>> {
  const reply = await sendRequestToBitfieldTarget({
    target: LOCAL_FILE_SELECTION_TARGET,
    // Browser-facing staging has one bounded source grammar: readable bytes.
    // A path token cannot be delegated through the admitted materializer because
    // it would reintroduce a caller-selected storage/source authority.
    payload: { ...options, includeBytes: true },
  });
  const payload = ownerPayload(reply);
  const files = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { files?: unknown }).files)
      ? (payload as { files: OwnerChosenFile[] }).files
      : [];
  return files.map(contentMediaFileFromLocalFile);
}

function isLocalContentMediaFile(file: File | LocalContentMediaFile): file is LocalContentMediaFile {
  return typeof (file as LocalContentMediaFile).localPath === 'string'
    && (file as LocalContentMediaFile).localPath.length > 0;
}

async function stageContentMediaLocalPath(input: StageContentMediaFileInput & { file: LocalContentMediaFile }): Promise<ContentMediaSourceRef> {
  throw new Error(`Local path ${input.file.localPath} is not an admitted artifact source; provide browser-readable bytes through the content-media materializer.`);
}

export async function stageContentMediaFile(input: StageContentMediaFileInput): Promise<ContentMediaSourceRef> {
  if (isLocalContentMediaFile(input.file)) {
    return stageContentMediaLocalPath({ ...input, file: input.file });
  }

  const packageName = safeSegment(input.packageName);
  const sourceId = input.sourceId ?? createContentMediaWorkId('source');
  const mediaType = contentMediaTypeForFile(input.file);
  // Trillion: the file itself goes to the materializer target, which keeps it in the person's Files through the one
  // uploader, so a recording of any length is kept (a byte array in a JSON request is bounded at 16 MB).
  const reply = await sendRequestToBitfieldTarget({
    target: MATERIALIZE_ARTIFACT_TARGET,
    payload: {
      source: {
        file: input.file,
        media_type: mediaType,
        display_name: input.file.name || mediaType,
        byte_length: input.file.size,
        provenance: { source_ref: sourceId, package_ref: packageName },
      },
      relation: { role_ref: { id: input.role ?? contentMediaRoleForFile(input.file) } },
    },
  });
  const stored = JSON.parse(new TextDecoder().decode(reply.payload)) as ContentMediaArtifactRef;

  return {
    role: input.role ?? contentMediaRoleForFile(input.file),
    media_type: mediaType,
    display_name: input.file.name || mediaType,
    artifact_ref: {
      kind: 'content-media.materialized-relation/v1',
      ...stored,
    },
  };
}

export async function submitWorkflowAction({
  definitionId,
  input,
  includeSteps = false,
  includeOutput = false,
}: SubmitWorkflowActionInput): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: WORKFLOW_TARGET,
    payload: {
      operation: 'execute_definition',
      definition_id: definitionId,
      include_steps: includeSteps,
      include_output: includeOutput,
      input,
    },
  });
}

export async function createContentMediaRelation(input: ContentMediaRelationInput): Promise<void> {
  await sendRequestToBitfieldTarget(buildCreateContentMediaRelationRequest(input));
}
