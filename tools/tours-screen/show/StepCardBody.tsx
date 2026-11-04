// parts/guided-overlay/show/StepCardBody.tsx
//
// PURPOSE
//   What a tour step's card holds: its progress (and close button) on the top row, its content, the note under it while
//   its condition waits, and its buttons on the bottom row. The running tour draws it inside the card it places beside
//   its target (WalkthroughSurface); the canvas draws the very same body for every step of a tour side by side, so what
//   the person edits there is the card the tour shows, never a copy that looks like it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. One body for every place a step's card is drawn; nothing here knows where it is drawn.
//   2. Nothing here names a content kind, a progress style or a button role: the registries and the buttons' DATA do.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import type { ReactElement, ReactNode } from 'react';
import { Container } from '../../ui/show/container/container';
import { Text } from '../../ui/show/text/Text';
import { StatusDot } from '../../ui/show/status-dot/StatusDot';
import { StepContent, type StepContentComponent } from '../../ui/show/step-content-renderer/StepContent';
import type { StepContentDescriptor, StepContentRegistry } from '../../ui/show/step-content-renderer/step-content-renderer';
import { StepProgress, type StepProgressComponent } from '../../ui/show/step-progress/StepProgress';
import { progressState, type StepProgressRegistry } from '../../ui/show/step-progress/step-progress';
import { NavButtons, type ButtonLooks, type NavButtonSpec } from './NavButtons';

export interface StepCardBodyProps {
  readonly fullScreen?: boolean;
  /** The closing step ("Tours are always here"): no progress, only its own buttons. */
  readonly closing?: boolean;
  readonly closeButton?: ReactNode;
  readonly tourTitle: string;
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly progressStyle: string;
  readonly progressReg: StepProgressRegistry<StepProgressComponent>;
  readonly contentReg: StepContentRegistry<StepContentComponent>;
  readonly content: StepContentDescriptor | null | undefined;
  readonly statusNote?: { text: string; ready: boolean } | null;
  readonly saving?: boolean;
  readonly savingWords?: string;
  readonly exitMessage?: string | null;
  readonly buttons: readonly NavButtonSpec[];
  readonly onAction: (role: string) => void;
  readonly isDisabled?: (role: string) => boolean;
  readonly looks?: ButtonLooks;
  readonly dialogTitleId?: string;
  readonly dialogDescriptionId?: string;
}

/** The body of one step's card, wherever it is drawn. */
export function StepCardBody({
  fullScreen = false, closing = false, closeButton = null, tourTitle, stepIndex, stepCount, progressStyle, progressReg,
  contentReg, content, statusNote = null, saving = false, savingWords = 'Saving your choice…', exitMessage = null,
  buttons, onAction, isDisabled, looks, dialogTitleId, dialogDescriptionId,
}: StepCardBodyProps): ReactElement {
  return (
    <Container
      layout="vertical"
      gap={fullScreen ? 'lg' : 'sm'}
      minHeight={fullScreen ? '100vh' : undefined}
      style={fullScreen ? { padding: 'clamp(2rem, 6vh, 5rem) clamp(2rem, 8vw, 9rem)' } : undefined}
      className={fullScreen
        ? 'min-h-screen px-[clamp(2rem,8vw,9rem)] py-[clamp(2rem,6vh,5rem)]'
        : undefined}
      data-full-screen-walkthrough={fullScreen ? 'true' : undefined}
    >
      {fullScreen && (
        <style>{`
          [data-full-screen-walkthrough="true"] [data-walkthrough-copy="title"] {
            font-size: clamp(2.75rem, 6vw, 6.5rem);
            line-height: 0.98;
          }
          [data-full-screen-walkthrough="true"] [data-walkthrough-copy="body"] {
            margin-top: 1.75rem;
            max-width: 48rem;
            font-size: clamp(1.125rem, 2vw, 1.75rem);
            line-height: 1.625;
          }
        `}</style>
      )}
      <span id={dialogTitleId} className="sr-only">
        {tourTitle}, step {stepIndex + 1} of {stepCount}
      </span>
      {/* Progress and the close button share the top row, above the words, so the buttons get the whole row under
          them and the card stays narrow. */}
      {((!fullScreen && !closing) || closeButton) && (
        <Container layout="horizontal" gap="sm" alignItems="center" justifyContent={!fullScreen && !closing ? 'between' : 'end'}>
          {!fullScreen && !closing && (
            <StepProgress
              registry={progressReg}
              style={progressStyle}
              state={progressState(stepIndex, stepCount)}
            />
          )}
          {closeButton}
        </Container>
      )}
      {content && (
        <div
          id={dialogDescriptionId}
          aria-live="polite"
          className={fullScreen
            ? 'my-auto max-w-5xl'
            : undefined}
        >
          <StepContent registry={contentReg} content={content} />
        </div>
      )}
      {statusNote && (
        <Container layout="horizontal" gap="sm" alignItems="center" role="status" aria-live="polite" data-walkthrough-status={statusNote.ready ? 'ready' : 'waiting'}>
          <StatusDot status={statusNote.ready ? 'success' : 'info'} pulse={!statusNote.ready} aria-hidden />
          <Text variant="body" weight="bold" color={statusNote.ready ? 'success' : 'muted'}>{statusNote.text}</Text>
        </Container>
      )}
      {saving && (
        <Text variant="body" role="status" aria-live="polite">{savingWords}</Text>
      )}
      {exitMessage && <Text variant="body" color="error" role="alert" aria-live="assertive">{exitMessage}</Text>}
      <Container
        layout="horizontal"
        gap="md"
        alignItems="center"
        justifyContent={closing || !fullScreen ? 'end' : 'between'}
        className={fullScreen ? 'mt-auto border-t border-[var(--border-primary)] pt-6' : undefined}
      >
        {closing || !fullScreen ? null : (
          <StepProgress
            registry={progressReg}
            style={progressStyle}
            state={progressState(stepIndex, stepCount)}
          />
        )}
        <NavButtons buttons={buttons} onAction={onAction} isDisabled={isDisabled} looks={looks} />
      </Container>
    </Container>
  );
}
