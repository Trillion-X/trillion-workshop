import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaptureAndAnalyzeSurface } from '@/packages/motion-analysis/show/CaptureAndAnalyzeSurface';

// Root vitest config has no testing-library auto-cleanup — clean up explicitly.
afterEach(() => cleanup());

describe('CaptureAndAnalyzeSurface', () => {
  it('idle shows the camera + a Start control that begins capture', () => {
    const onStart = vi.fn();
    render(
      <CaptureAndAnalyzeSurface
        stage="idle"
        cameraSlot={<span>camera-preview</span>}
        onStart={onStart}
        startLabel="Start"
      />,
    );
    expect(screen.getByText('camera-preview')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('recording shows the timer pill + a Stop control that ends capture', () => {
    const onStop = vi.fn();
    render(<CaptureAndAnalyzeSurface stage="recording" elapsedMs={42_000} onStop={onStop} stopLabel="Stop" />);
    expect(screen.getByText('00:42')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('working shows the working line and no pressable control', () => {
    render(<CaptureAndAnalyzeSurface stage="working" workingLabel="Reading your game…" />);
    expect(screen.getByText('Reading your game…')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('result hands the screen to the resultView (no capture control)', () => {
    render(<CaptureAndAnalyzeSurface stage="result" resultView={<span>your-stats-dashboard</span>} />);
    expect(screen.getByText('your-stats-dashboard')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('error shows a human line + retry that re-runs onStart', () => {
    const onStart = vi.fn();
    render(
      <CaptureAndAnalyzeSurface
        stage="error"
        errorMessage="Couldn’t read that clip — try again with the full court in frame."
        onStart={onStart}
        retryLabel="Try again"
      />,
    );
    expect(screen.getByText('Couldn’t read that clip — try again with the full court in frame.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('carries no domain vocabulary by default (neutral verbs)', () => {
    const { rerender } = render(<CaptureAndAnalyzeSurface stage="idle" />);
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
    rerender(<CaptureAndAnalyzeSurface stage="recording" elapsedMs={0} />);
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
  });
});
