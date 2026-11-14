import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingInfoOverlay } from '../SettingInfoOverlay';

afterEach(cleanup);

describe('SettingInfoOverlay', () => {
  const descriptor = {
    key: 'testSetting',
    title: 'Test Setting',
    description: 'This is a test setting description',
    visualUrl: 'https://example.com/demo.png',
    visualLabel: 'Before and after',
  };

  it('renders help icon button', () => {
    render(<SettingInfoOverlay descriptor={descriptor} />);
    const button = screen.getByLabelText('Help for Test Setting');
    expect(button).toBeTruthy();
  });

  it('opens overlay on button click', async () => {
    const user = userEvent.setup();
    render(<SettingInfoOverlay descriptor={descriptor} />);

    const button = screen.getByLabelText('Help for Test Setting');
    await user.click(button);

    expect(screen.getByText('Test Setting')).toBeTruthy();
    expect(screen.getByText('This is a test setting description')).toBeTruthy();
  });

  it('displays visual when visualUrl provided', async () => {
    const user = userEvent.setup();
    render(<SettingInfoOverlay descriptor={descriptor} />);

    const button = screen.getByLabelText('Help for Test Setting');
    await user.click(button);

    const image = screen.getByAltText('Visual demo for Test Setting');
    expect(image.getAttribute('src')).toBe('https://example.com/demo.png');
  });

  it('displays visual label when provided', async () => {
    const user = userEvent.setup();
    render(<SettingInfoOverlay descriptor={descriptor} />);

    const button = screen.getByLabelText('Help for Test Setting');
    await user.click(button);

    expect(screen.getByText('Before and after')).toBeTruthy();
  });

  it('hides visual when visualUrl absent', async () => {
    const user = userEvent.setup();
    const descriptorNoVisual = { ...descriptor, visualUrl: undefined };
    render(<SettingInfoOverlay descriptor={descriptorNoVisual} />);

    const button = screen.getByLabelText('Help for Test Setting');
    await user.click(button);

    expect(screen.queryByAltText(/Visual demo/)).toBeNull();
  });

  it('closes overlay on close button click', async () => {
    const user = userEvent.setup();
    render(<SettingInfoOverlay descriptor={descriptor} />);

    const button = screen.getByLabelText('Help for Test Setting');
    await user.click(button);

    const closeButton = screen.getByLabelText('Close');
    await user.click(closeButton);

    expect(screen.queryByText('Test Setting')).toBeNull();
  });

  it('toggles open state on button click', async () => {
    const user = userEvent.setup();
    render(<SettingInfoOverlay descriptor={descriptor} />);

    const button = screen.getByLabelText('Help for Test Setting');

    // Open
    await user.click(button);
    expect(screen.getByText('Test Setting')).toBeTruthy();

    // Close
    await user.click(button);
    expect(screen.queryByText('Test Setting')).toBeNull();
  });
});
