// packages/bug-reports/show/BugReportModal.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Modal for quick bug report submission. Three structured fields capture what
// the user did, what they expected, and what actually happened. Submits through
// the canonical bug-report owner action.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Glassmorphism modal with backdrop blur
// 2. Three required fields: did, expected, happened
// 3. Escape key and backdrop click close the modal
// 4. Submit invokes the package-configured quick bug-report action
// 5. Success feedback before auto-close
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React, { useState, useCallback, useEffect } from 'react';
import { Send, CheckCircle } from 'lucide-react';
import { createQuickBugReport } from '@/packages/bug-reports/do-work/create-quick-bug-report';
import { Textarea, Button, Text, Icon } from '@/packages/ui';
import { FloatingPanel } from '@/packages/screen-arrangement/show/FloatingPanel';

// ============================================================================
// TYPES
// ============================================================================

export interface BugReportModalProps {
  /** Whether the modal is open */
  open: boolean;
  /** Callback to close the modal */
  onClose: () => void;
}

// ============================================================================
// PURE FUNCTIONS
// ============================================================================

/** Build the bug report description from the three fields */
export function formatBugReport(did: string, expected: string, happened: string): string {
  return [
    'What I did:',
    did.trim(),
    '',
    'What I expected:',
    expected.trim(),
    '',
    'What actually happened:',
    happened.trim(),
  ].join('\n');
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function BugReportModal({ open, onClose }: BugReportModalProps) {
  const [did, setDid] = useState('');
  const [expected, setExpected] = useState('');
  const [happened, setHappened] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  // Reset form when modal closes
  useEffect(() => {
    if (!open) {
      setDid('');
      setExpected('');
      setHappened('');
      setSubmitting(false);
      setSubmitted(false);
    }
  }, [open]);

  const canSubmit = did.trim().length > 0 && expected.trim().length > 0 && happened.trim().length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      const reportId = `bug_report:${crypto.randomUUID()}`;
      const description = formatBugReport(did, expected, happened);
      const timestamp = new Date().toISOString();

      await createQuickBugReport({
        report_id: reportId,
        title: 'Quick bug report',
        description,
        steps_to_reproduce: did.trim(),
        severity: 'untriaged',
        reported_at: timestamp,
      });
      setSubmitted(true);
      setTimeout(onClose, 1500);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, submitting, onClose, did, expected, happened]);

  return (
    <FloatingPanel open={open} onClose={onClose} title="Quick Bug Report">
      {submitted ? (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <Icon icon={CheckCircle} size="xl" color="success" />
          <Text variant="body" color="success">Report submitted to investigation inbox</Text>
        </div>
      ) : (
        <>
          {/* Fields */}
          <div className="space-y-3">
            <Textarea
              label="What did you do?"
              value={did}
              onChange={(e) => setDid(e.target.value)}
              placeholder="Describe the steps you took..."
              rows={2}
              className="text-xs"
            />
            <Textarea
              label="What did you expect?"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
              placeholder="What should have happened..."
              rows={2}
              className="text-xs"
            />
            <Textarea
              label="What actually happened?"
              value={happened}
              onChange={(e) => setHappened(e.target.value)}
              placeholder="What went wrong..."
              rows={2}
              className="text-xs"
            />
          </div>

          {/* Submit */}
          <Button
            variant="accent"
            onClick={handleSubmit}
            disabled={!canSubmit}
            loading={submitting}
            className="mt-4 w-full"
          >
            <Icon icon={Send} size="sm" />
            {submitting ? 'Submitting...' : 'Submit Report'}
          </Button>
        </>
      )}
    </FloatingPanel>
  );
}
