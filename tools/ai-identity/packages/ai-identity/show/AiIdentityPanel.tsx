// bitfield/packages/ai-identity/show/AiIdentityPanel.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// AI Identity configuration panel. Reads primary identity rows from package data
// and saves editable fields through the owner action.
// Displays read-only email handle, wallet handle, and model id fields.
// Status badge indicates the identity setup state.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All UI through ui/ components — zero raw HTML, zero inline styles except Container
// 2. Feed-backed read extracts all projected fields from the owner-published record
// 3. useBitfieldData() reads descriptor-scoped data; workflow owner action handles mutations
// 4. Status badge color: pending_setup=warning, active=success, disabled=muted
// 5. Name and persona fields are editable with update button
// 6. Email handle and wallet handle are read-only
// 7. Full file header with PURPOSE, INVARIANTS, AI DIRECTIVE
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
//
// =============================================================================

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Card, Container, Text, Button, Badge, Input, Spinner } from '@/packages/ui';
import {
  decodeAiIdentityFeed,
  type AiIdentity,
} from '@/packages/ai-identity/read-data/read-ai-identity';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { updateAiIdentityProfile } from '@/packages/ai-identity/do-work/update-ai-identity-profile';

// ============================================================================
// COMPONENT
// ============================================================================

function AiIdentityPanelContents() {
  // -----------------------------------------------------------------------
  // SDK HOOKS
  // -----------------------------------------------------------------------

  const identityRecordsEntry = useBitfieldData();
  const identities = useMemo(
    () => decodeAiIdentityFeed(identityRecordsEntry)
      .filter((record) => record.id === 'ai_identity:primary'),
    [identityRecordsEntry],
  );
  const isLoading = identityRecordsEntry === null;
  const queryError = false;

  // -----------------------------------------------------------------------
  // LOCAL STATE
  // -----------------------------------------------------------------------

  const [editingName, setEditingName] = useState('');
  const [editingPersona, setEditingPersona] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Get current identity (first row, or null if not found)
  const identity = useMemo(() => identities?.[0] || null, [identities]);

  // Initialize edit fields when identity loads
  useEffect(() => {
    if (identity && !isEditing) {
      setEditingName(identity.name);
      setEditingPersona(identity.persona);
    }
  }, [identity, isEditing]);

  // -----------------------------------------------------------------------
  // HANDLERS
  // -----------------------------------------------------------------------

  const handleEdit = useCallback(() => {
    if (identity) {
      setEditingName(identity.name);
      setEditingPersona(identity.persona);
      setIsEditing(true);
    }
  }, [identity]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    if (identity) {
      setEditingName(identity.name);
      setEditingPersona(identity.persona);
    }
  }, [identity]);

  const handleSave = useCallback(async () => {
    if (!identity) return;

    setIsSaving(true);
    try {
      if (editingName !== identity.name || editingPersona !== identity.persona) {
        await updateAiIdentityProfile({
          name: editingName,
          persona: editingPersona,
        });
      }

      setIsEditing(false);
    } catch (err) {
      console.error('[AiIdentityPanel] Failed to save identity:', err);
    } finally {
      setIsSaving(false);
    }
  }, [identity, editingName, editingPersona]);

  // -----------------------------------------------------------------------
  // STATUS BADGE VARIANT
  // -----------------------------------------------------------------------

  const getStatusVariant = (status: string): 'success' | 'warning' | 'error' | 'neutral' => {
    switch (status) {
      case 'active':
        return 'success';
      case 'pending_setup':
        return 'warning';
      case 'disabled':
        return 'neutral';
      default:
        return 'neutral';
    }
  };

  // -----------------------------------------------------------------------
  // RENDER
  // -----------------------------------------------------------------------

  if (isLoading) {
    return (
      <Container
        layout="vertical"
        gap="none"
        alignItems="center"
        justifyContent="center"
        height="full"
      >
        <Spinner />
      </Container>
    );
  }

  if (queryError || !identity) {
    return (
      <Container layout="vertical" gap="lg">
        <Card variant="surface">
          <Container layout="vertical" gap="md">
            <Text variant="heading" size="md">
              AI Identity
            </Text>
            <Text variant="body" color="error">
              {queryError?.message || 'Failed to load AI identity'}
            </Text>
          </Container>
        </Card>
      </Container>
    );
  }

  // -----------------------------------------------------------------------
  // RENDER — Card with fields
  // -----------------------------------------------------------------------

  return (
    <Container layout="vertical" gap="lg">
      <Card variant="surface">
        <Container layout="vertical" gap="lg">
          {/* Header with title and status badge */}
          <Container layout="horizontal" gap="md">
            <Container layout="vertical" gap="xs" flex={1}>
              <Text variant="heading" size="md">
                AI Identity
              </Text>
              <Text variant="caption" color="muted">
                Manage your AI assistant's identity and configuration
              </Text>
            </Container>
            <Badge variant={getStatusVariant(identity.status)} size="md">
              {identity.status.replace('_', ' ')}
            </Badge>
          </Container>

          {/* Editable fields */}
          {isEditing ? (
            <Container layout="vertical" gap="md">
              {/* Name field */}
              <Container layout="vertical" gap="xs">
                <Text variant="caption" weight="medium">
                  Name
                </Text>
                <Input
                  type="text"
                  value={editingName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setEditingName(e.target.value)
                  }
                  placeholder="Assistant name"
                  disabled={isSaving}
                />
              </Container>

              {/* Persona field */}
              <Container layout="vertical" gap="xs">
                <Text variant="caption" weight="medium">
                  Persona
                </Text>
                <Input
                  type="text"
                  value={editingPersona}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setEditingPersona(e.target.value)
                  }
                  placeholder="Describe your AI assistant's personality and role"
                  disabled={isSaving}
                />
              </Container>

              {/* Save/Cancel buttons */}
              <Container layout="horizontal" gap="xs">
                <Button
                  variant="primary"
                  onClick={handleSave}
                  disabled={isSaving}
                >
                  {isSaving ? 'Saving...' : 'Save'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={handleCancel}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
              </Container>
            </Container>
          ) : (
            <Container layout="vertical" gap="md">
              {/* Name (read-only display) */}
              <Container layout="vertical" gap="xs">
                <Text variant="caption" weight="medium" color="muted">
                  Name
                </Text>
                <Text variant="body">{identity.name}</Text>
              </Container>

              {/* Persona (read-only display) */}
              <Container layout="vertical" gap="xs">
                <Text variant="caption" weight="medium" color="muted">
                  Persona
                </Text>
                <Text variant="body">{identity.persona || '—'}</Text>
              </Container>

              {/* Model ID (read-only) */}
              {identity.modelId && (
                <Container layout="vertical" gap="xs">
                  <Text variant="caption" weight="medium" color="muted">
                    Model ID
                  </Text>
                  <Text variant="caption" family="mono">
                    {identity.modelId}
                  </Text>
                </Container>
              )}

              {/* Email Handle (read-only) */}
              {identity.emailHandle && (
                <Container layout="vertical" gap="xs">
                  <Text variant="caption" weight="medium" color="muted">
                    Email Handle
                  </Text>
                  <Text variant="caption">{identity.emailHandle}</Text>
                </Container>
              )}

              {/* Wallet Handle (read-only) */}
              {identity.walletHandle && (
                <Container layout="vertical" gap="xs">
                  <Text variant="caption" weight="medium" color="muted">
                    Wallet Handle
                  </Text>
                  <Text variant="caption" family="mono">
                    {identity.walletHandle}
                  </Text>
                </Container>
              )}

              {/* Edit button */}
              <Button variant="primary" onClick={handleEdit}>
                Edit Identity
              </Button>
            </Container>
          )}
        </Container>
      </Card>
    </Container>
  );
}

export function AiIdentityPanel() {
  return <AiIdentityPanelContents />;
}
