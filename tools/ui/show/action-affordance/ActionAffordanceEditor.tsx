// packages/ui/show/action-affordance/ActionAffordanceEditor.tsx
//
// The "New action" authoring modal. Emits a draft — it never writes and never
// sends; the host owns persistence. Options (what it can run, where it shows)
// arrive as caller DATA rows.

import React, { useState } from 'react';
import { Button } from '../button';
import { Container } from '../container';
import { Text } from '../text';
import { Textarea } from '../input';
import type { ActionAffordanceDraft } from './write-action-affordance';
import { FloatingPanel } from '../../../screen-arrangement/show/FloatingPanel';

/** One runnable choice (an admitted definition), caller DATA. */
export interface AffordanceDefinitionOption {
  readonly id: string;
  readonly label: string;
  /** Literal input rows this choice needs on every run (opaque to the editor). */
  readonly literalInput?: Record<string, unknown>;
  /** The status polling block runs of this choice are observed with. */
  readonly status?: ActionAffordanceDraft['status'];
}

/** One place the action can show, caller DATA. */
export interface AffordanceChannelOption {
  readonly channel: string;
  readonly label: string;
}

export interface ActionAffordanceEditorProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Host-minted run id for record identity (no Date/random inside). */
  readonly runId: string;
  readonly definitionOptions: readonly AffordanceDefinitionOption[];
  readonly channelOptions: readonly AffordanceChannelOption[];
  readonly onSave: (draft: ActionAffordanceDraft) => void | Promise<void>;
  /** EDIT mode: prefill from an existing action's decoded draft
   *  (`draftOfActionAffordanceRecord`). The editor is the SAME surface either
   *  way (L069) — only the prefill + title change; the host decides whether the
   *  save creates or edits-in-place. Absent → the blank "New action" flow. */
  readonly initialDraft?: ActionAffordanceDraft | null;
}

export function ActionAffordanceEditor({
  open,
  onClose,
  runId,
  definitionOptions,
  channelOptions,
  onSave,
  initialDraft,
}: ActionAffordanceEditorProps): React.ReactElement | null {
  const [label, setLabel] = useState('');
  const [instruction, setInstruction] = useState('');
  const [section, setSection] = useState('');
  const [definitionId, setDefinitionId] = useState(definitionOptions[0]?.id ?? '');
  const [channels, setChannels] = useState<readonly string[]>(
    channelOptions.map((c) => c.channel),
  );
  // Prefill on open (keyed by runId — a fresh open mints a fresh runId, so an
  // edit session prefILLS once and later keystrokes are never clobbered).
  const prefilledFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!open || prefilledFor.current === runId) return;
    prefilledFor.current = runId;
    setLabel(initialDraft?.label ?? '');
    setInstruction(initialDraft?.instruction ?? '');
    setSection(initialDraft?.section ?? '');
    setDefinitionId(initialDraft?.definitionId ?? definitionOptions[0]?.id ?? '');
    setChannels(initialDraft?.channels?.length ? initialDraft.channels : channelOptions.map((c) => c.channel));
  }, [open, runId, initialDraft, definitionOptions, channelOptions]);
  if (!open) return null;

  const chosen = definitionOptions.find((d) => d.id === definitionId) ?? definitionOptions[0];
  const canSave = label.trim().length > 0 && !!chosen && channels.length > 0;

  const save = () => {
    if (!canSave || !chosen) return;
    void onSave({
      label: label.trim(),
      ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
      ...(section.trim() ? { section: section.trim() } : {}),
      definitionId: chosen.id,
      // EDIT mode preserves the record's own run rows (literalInput/status/ask)
      // when the chosen definition matches — a prefill must not silently strip
      // what the original carried; a definition CHANGE re-derives from the option.
      ...(initialDraft && initialDraft.definitionId === chosen.id
        ? {
            ...(initialDraft.literalInput ? { literalInput: initialDraft.literalInput } : {}),
            ...(initialDraft.status ? { status: initialDraft.status } : {}),
            ...(initialDraft.askPrompt ? { askPrompt: initialDraft.askPrompt } : {}),
          }
        : {
            ...(chosen.literalInput ? { literalInput: chosen.literalInput } : {}),
            ...(chosen.status ? { status: chosen.status } : {}),
          }),
      channels,
      runId,
    });
    onClose();
  };

  const toggleChannel = (channel: string) => {
    setChannels((current) =>
      current.includes(channel) ? current.filter((c) => c !== channel) : [...current, channel],
    );
  };

  return (
    <FloatingPanel open onClose={onClose} title={initialDraft ? 'Edit action' : 'New action'}>
      <Container layout="vertical" gap="md" padding="md">
        <Container layout="vertical" gap="xs">
          <Text variant="label">Name</Text>
          <Textarea
            value={label}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setLabel(e.target.value)}
            placeholder="Turn this into a blog post"
            rows={1}
          />
        </Container>
        <Container layout="vertical" gap="xs">
          <Text variant="label">Instruction</Text>
          <Textarea
            value={instruction}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInstruction(e.target.value)}
            placeholder="Turn this into a blog post that is amazing"
            rows={2}
          />
        </Container>
        <Container layout="vertical" gap="xs">
          <Text variant="label">Menu group</Text>
          <Textarea
            value={section}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setSection(e.target.value)}
            placeholder="Writing"
            rows={1}
          />
        </Container>
        <Container layout="vertical" gap="xs">
          <Text variant="label">What it runs</Text>
          <Container layout="vertical" gap="xs">
            {definitionOptions.map((option) => (
              <Button
                key={option.id}
                variant={option.id === definitionId ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => setDefinitionId(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </Container>
        </Container>
        <Container layout="vertical" gap="xs">
          <Text variant="label">Where it shows</Text>
          <Container layout="horizontal" gap="xs">
            {channelOptions.map((option) => (
              <Button
                key={option.channel}
                variant={channels.includes(option.channel) ? 'secondary' : 'ghost'}
                size="sm"
                onClick={() => toggleChannel(option.channel)}
              >
                {option.label}
              </Button>
            ))}
          </Container>
        </Container>
        <Container layout="horizontal" gap="sm" justifyContent="end">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!canSave} onClick={save}>Save action</Button>
        </Container>
      </Container>
    </FloatingPanel>
  );
}
