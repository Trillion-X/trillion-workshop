import React from 'react';
import {RotateCcw, SkipBack, SkipForward} from 'lucide-react';
import {Button} from './coss/ui/button';
import {playbackCompletionLook as look} from '../../screen-look/show/timed-text-style';

type CompletionAction = {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  onSelect: () => void | Promise<void>;
};

/** Shared completion face, using the existing licensed Coss Button primitive.
 * Playback owns its state and actions; controls publish their occupied inset.
 * Overflow belongs to this card so every action stays reachable on short media. */
export function PlaybackCompletion({actions = [], onRestart, title = 'Finished', visible}: {
  actions?: readonly CompletionAction[];
  onRestart: () => void | Promise<void>;
  title?: string;
  visible: boolean;
}) {
  if (!visible) return null;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const select = (action: () => void | Promise<void>) => (event: React.MouseEvent) => {
    event.preventDefault(); event.stopPropagation(); void action();
  };
  return <div className={look.overlay} data-media-playback-completion data-testid="media-playback-completion" onClick={stop} onPointerDown={stop}>
    <div className={look.card} role="region" aria-label="Playback completion" tabIndex={0} data-media-completion-scroll>
      <h3 className={look.title}>{title}</h3>
      <div className={look.actions}>
        <Button variant="outline" className={look.action} data-media-completion-action="restart" onClick={select(onRestart)} onPointerDown={stop}>
          <RotateCcw className={look.icon} aria-hidden="true" />Restart
        </Button>
        {actions.map(action => {
          const key = action.id.toLowerCase();
          const DirectionIcon = key.includes('previous') || key.includes('back') ? SkipBack : SkipForward;
          return <Button variant="outline" className={look.action} data-media-completion-action={action.id} disabled={action.disabled} key={action.id} onClick={select(action.onSelect)} onPointerDown={stop}>
            <span className={look.actionContent}>
              <span className={look.actionLabel}><DirectionIcon className={look.icon} aria-hidden="true" />{action.label}</span>
              {action.detail ? <span className={look.detail}>{action.detail}</span> : null}
            </span>
          </Button>;
        })}
      </div>
    </div>
  </div>;
}
