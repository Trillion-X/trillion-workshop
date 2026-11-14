import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';

import { Button } from '@/packages/ui/show/button';
import { Icon } from '@/packages/ui/show/icon';
import { Text } from '@/packages/ui/show/text';
import { Tooltip } from '@/packages/ui/show/tooltip';

export interface SoundToggleProps {
  soundEnabled: boolean;
  onSoundEnabledChange: (enabled: boolean) => void;
  showLabel?: boolean;
}

export function SoundToggle({ soundEnabled, onSoundEnabledChange, showLabel = true }: SoundToggleProps) {
  const label = soundEnabled ? 'Sound On' : 'Sound Off';
  const tooltipLabel = soundEnabled ? 'Sound on (m to toggle)' : 'Sound off (m to toggle)';

  return (
    <Tooltip label={tooltipLabel} side="right">
      <Button
        variant="ghost"
        size="nav"
        onClick={() => onSoundEnabledChange(!soundEnabled)}
        active={soundEnabled}
        aria-label={soundEnabled ? 'Mute sound' : 'Unmute sound'}
      >
        <Icon icon={soundEnabled ? Volume2 : VolumeX} size="lg" />
        {showLabel && <Text>{label}</Text>}
      </Button>
    </Tooltip>
  );
}
