// PORTED FROM: bitfield-packages/packages/chat/show/PresetPopover.test.tsx @ e99ac5976
// PresetPopover — verifies it is a thin CONFIG of the shared ui/ GroupedPicker
// (#47 / contract #60 step 3), not a bespoke popover. Asserts the empty state
// (null) and that enabled presets surface the "Presets" trigger (GroupedPicker's
// trigger renders without opening the portal, so jsdom can see it).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PresetPopover } from './PresetPopover';
import type { Preset } from '../read-data/read-chat-presets';

afterEach(cleanup);

function preset(over: Partial<Preset> = {}): Preset {
  return {
    id: 'run-task',
    label: 'Run Task',
    icon: 'play',
    category: 'general',
    prompt: 'Run the current task.',
    description: 'Kick off the active task',
    enabled: true,
    order: 0,
    ...over,
  } as Preset;
}

describe('PresetPopover — GroupedPicker config', () => {
  it('renders nothing when there are no enabled presets', () => {
    const { container } = render(<PresetPopover presets={[]} onSelectPreset={() => {}} />);
    expect(container.textContent).toBe('');
    const { container: c2 } = render(
      <PresetPopover presets={[preset({ enabled: false })]} onSelectPreset={() => {}} />,
    );
    expect(c2.textContent).toBe('');
  });

  it('surfaces the "Presets" trigger when enabled presets exist', () => {
    render(
      <PresetPopover
        presets={[preset(), preset({ id: 'refactor', label: 'Refactor', order: 1 })]}
        onSelectPreset={vi.fn()}
      />,
    );
    // GroupedPicker's trigger button renders eagerly (only the panel is portaled).
    expect(screen.getByText('Presets')).toBeTruthy();
  });
});
