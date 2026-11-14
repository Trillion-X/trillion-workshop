import React, { useEffect, useMemo, useState } from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ActionControl, Container, OpenSurfaceAction, Text } from '@/packages/ui';
import { setSelectedAgent, SELECTED_AGENT_ACTION } from '@/packages/selected-agent/do-work/set-selected-agent';
import {
  readSelectedAgentAction,
  readSelectedAgentId,
} from '@/packages/selected-agent/read-data/read-selected-agent';
import { UnifiedAgentPicker } from '@/packages/chat/show/input/unified-agent-picker';
import { decodeCliRegistryParticipants } from '@/packages/chat/read-data/read-cli-registry-participants';
import {
  chooseAgentPresentationParticipants,
  decodeAgentProfileParticipants,
} from '@/packages/chat/read-data/read-agent-profile-participants';
import { decodeAddressedParticipantsFeed } from '@/packages/chat/read-data/read-addressed-exchange-participants';
import { mergeAgentSelectionParticipants } from '@/packages/chat/read-data/merge-agent-selection-participants';
import {
  filterRunnableAiModelDescriptors,
  readRunnableAiProviderRefs,
} from '@/packages/selected-agent/read-data/read-runnable-ai-providers';
import type { ChatSessionConfig } from '@/packages/chat/read-data/read-chat-sessions';

export interface AgentSelectionSurfaceProps {
  surfaceInput?: Record<string, unknown>;
}

type PendingSelection = {
  participantRef: string;
  modelId: string | null;
  label: string;
};

export function AgentSelectionSurface({ surfaceInput }: AgentSelectionSurfaceProps) {
  const selectedAgentEntry = useBitfieldData('selected-agent');
  const cliRegistryEntry = useBitfieldData('cli-registry');
  const agentProfileEntry = useBitfieldData('agent-profile-participants');
  const addressedParticipantsEntry = useBitfieldData('addressed-exchange-participants');
  const modelDescriptorsEntry = useBitfieldData('chat-model-descriptors');
  const providerRoutingFactsEntry = useBitfieldData('provider-routing-facts');
  const runnableProviderRefs = useMemo(
    () => readRunnableAiProviderRefs(providerRoutingFactsEntry),
    [providerRoutingFactsEntry],
  );
  const runnableModelDescriptors = useMemo(
    () => filterRunnableAiModelDescriptors(modelDescriptorsEntry, runnableProviderRefs),
    [modelDescriptorsEntry, runnableProviderRefs],
  );

  const selectedAgentId = readSelectedAgentId(selectedAgentEntry);
  const cliParticipants = useMemo(
    () => decodeCliRegistryParticipants(cliRegistryEntry),
    [cliRegistryEntry],
  );
  const profileParticipants = useMemo(
    () => decodeAgentProfileParticipants(agentProfileEntry, { descriptors: runnableModelDescriptors }),
    [agentProfileEntry, runnableModelDescriptors],
  );
  const addressedParticipants = useMemo(
    () => decodeAddressedParticipantsFeed(addressedParticipantsEntry),
    [addressedParticipantsEntry],
  );
  const participants = useMemo(() => mergeAgentSelectionParticipants([
    ...chooseAgentPresentationParticipants(cliParticipants, profileParticipants),
    ...addressedParticipants,
  ]), [addressedParticipants, cliParticipants, profileParticipants]);
  const hasAvailableAi = useMemo(
    () => runnableProviderRefs.size > 0,
    [runnableProviderRefs],
  );

  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [savedLabel, setSavedLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const actionRef = readSelectedAgentAction(surfaceInput, SELECTED_AGENT_ACTION);
  const activeParticipantRef = pending?.participantRef ?? selectedAgentId;
  const activeParticipant = participants.find(
    (participant) => participant.participantRef === activeParticipantRef,
  );
  const config = useMemo<ChatSessionConfig>(() => ({
    participantRefs: activeParticipantRef ? [activeParticipantRef] : [],
    participantRef: activeParticipantRef,
    accountId: activeParticipant?.accounts[0]?.id ?? '',
    model: pending?.modelId ?? null,
  }), [activeParticipant?.accounts, activeParticipantRef, pending?.modelId]);

  useEffect(() => {
    if (!pending || pending.participantRef !== selectedAgentId) return;
    setSavedLabel(pending.label);
    setPending(null);
  }, [pending, selectedAgentId]);

  const persistSelection = (participantRef: string, modelId: string | null) => {
    const participant = participants.find((candidate) => candidate.participantRef === participantRef);
    const label = participant?.label ?? 'Your AI';
    const next = { participantRef, modelId, label };
    setPending(next);
    setSavedLabel('');
    setError(null);
    void setSelectedAgent(participantRef, actionRef).catch(() => {
      setPending(null);
      setError('Your AI choice could not be saved. Nothing changed.');
    });
  };

  const persistAutoSelection = () => {
    const next = { participantRef: '', modelId: null, label: 'Automatic selection' };
    setPending(next);
    setSavedLabel('');
    setError(null);
    void setSelectedAgent('', actionRef).catch(() => {
      setPending(null);
      setError('Automatic selection could not be saved. Nothing changed.');
    });
  };

  const retry = () => {
    const participantRef = activeParticipantRef;
    if (participantRef) persistSelection(participantRef, config.model);
    else persistAutoSelection();
  };

  return (
    <Container
      layout="vertical"
      gap="xl"
      padding="xl"
      alignItems="center"
      justifyContent="center"
      height="full"
      minHeight="0"
    >
      <Container layout="vertical" gap="sm" alignItems="center" padding="none">
        <Text variant="heading">Your AI</Text>
        <Text variant="body" color="muted">
          {hasAvailableAi
            ? 'Choose who should work with you, or choose automatically.'
            : 'Connect an AI to get started.'}
        </Text>
      </Container>

      {hasAvailableAi ? (
        <UnifiedAgentPicker
          participants={participants}
          config={config}
          onSelect={persistSelection}
          onSelectAuto={persistAutoSelection}
          canChange
          disabled={pending !== null}
        />
      ) : (
        <OpenSurfaceAction
          payload={{
            id: 'service-connections.settings',
            surfaceInput: { initial_categories: ['AI'] },
          }}
          label="Connect AI"
          detail="Choose any AI service that works for you."
          unavailableMessage="Open Connected services to connect an AI."
        />
      )}

      <Container layout="vertical" gap="sm" alignItems="center" padding="none">
        {!hasAvailableAi ? (
          <Text variant="body" color="muted" role="status">Connect an AI to continue.</Text>
        ) : pending ? (
          <Text variant="body" color="muted" role="status">Saving your choice...</Text>
        ) : savedLabel ? (
          <Text variant="body" color="success" role="status">Ready. {savedLabel} is selected.</Text>
        ) : selectedAgentId && activeParticipant ? (
          <Text variant="body" color="success" role="status">Ready. {activeParticipant.label} is selected.</Text>
        ) : (
          <Text variant="body" color="muted" role="status">The best available AI will be chosen automatically.</Text>
        )}
        {error ? (
          <>
            <Text variant="body" color="error" role="alert">{error}</Text>
            <ActionControl variant="secondary" size="sm" onClick={retry}>Try again</ActionControl>
          </>
        ) : null}
      </Container>
    </Container>
  );
}
