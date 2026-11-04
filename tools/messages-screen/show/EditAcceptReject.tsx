// PORTED FROM: bitfield-packages/packages/chat/show/EditAcceptReject.tsx @ e99ac5976
// frontends/web/src/packages/chat/show/EditAcceptReject.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// UI component for reviewing and accepting/rejecting AI file edits within
// chat tool_use blocks. Shows a diff preview and action buttons. Reuses the
// DiffView pattern from ToolRendererDiff for consistency.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Displays diff with old content (red) vs new content (green)
// 2. Shows file path in header for context
// 3. Accept and Reject buttons are mutually exclusive (once acted, disabled)
// 4. After action, shows status badge ("Applied" in green, "Rejected" in muted)
// 5. All UI through ui/ components (Container, Button, Badge, Text, Icon)
// 6. ZERO raw HTML (div/span/p) — strict L065 compliance
// 7. L066: Import only from @/packages/ui barrel or relative ui/ paths
//
// =============================================================================
// KEY CONCEPTS
// =============================================================================
//
// - filePath: string — the file being edited
// - oldContent: string — content before edit
// - newContent: string — content after edit
// - onAccept: callback when user approves the edit
// - onReject: callback when user declines the edit
// - status: local state tracking 'pending' | 'applied' | 'rejected'
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState } from 'react';
import { Check, X } from 'lucide-react';
import { ChatFileContent } from './ChatFileContent';
import { Container, Button, Badge, Text, Icon } from '../../ui';

/**
 * Props for EditAcceptReject component
 */
export interface EditAcceptRejectProps {
  /** Absolute file path being edited */
  filePath: string;
  /** Original content before the edit */
  oldContent: string;
  /** New content proposed by the edit */
  newContent: string;
  /** Callback when user accepts the edit */
  onAccept: () => void;
  /** Callback when user rejects the edit */
  onReject: () => void;
}

/**
 * Component for accepting/rejecting AI file edits with diff preview
 */
export function EditAcceptReject({
  filePath,
  oldContent,
  newContent,
  onAccept,
  onReject,
}: EditAcceptRejectProps) {
  const [status, setStatus] = useState<'pending' | 'applied' | 'rejected'>('pending');
  const isActioned = status !== 'pending';

  const handleAccept = () => {
    onAccept();
    setStatus('applied');
  };

  const handleReject = () => {
    onReject();
    setStatus('rejected');
  };

  return (
    <Container layout="vertical" gap="md">
      {/* Diff preview */}
      <ChatFileContent
        filePath={filePath}
        diff={{ oldString: oldContent, newString: newContent }}
        maxHeight="24rem"
        showHeader
      />

      {/* Action buttons */}
      <Container layout="horizontal" gap="sm" alignItems="center">
        <Button
          variant="solid"
          color="success"
          size="sm"
          disabled={isActioned}
          onClick={handleAccept}
          aria-label="Accept edit"
        >
          <Icon icon={Check} size="sm" />
          Accept
        </Button>

        <Button
          variant="outline"
          size="sm"
          disabled={isActioned}
          onClick={handleReject}
          aria-label="Reject edit"
        >
          <Icon icon={X} size="sm" />
          Reject
        </Button>

        {/* Status badge after action */}
        {status === 'applied' && (
          <Badge variant="success" size="sm">
            <Icon icon={Check} size="xs" />
            Applied
          </Badge>
        )}

        {status === 'rejected' && (
          <Badge variant="neutral" size="sm">
            <Icon icon={X} size="xs" />
            Rejected
          </Badge>
        )}
      </Container>
    </Container>
  );
}
