// packages/screen-recording/do-work/browser-screen-capture.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  screenCaptureAvailability,
  isScreenCaptureAvailable,
} from './browser-screen-capture';

describe('browser-screen-capture', () => {
  describe('screenCaptureAvailability', () => {
    it('returns "navigator.mediaDevices.getDisplayMedia" when available', () => {
      const mockNavigator = {
        mediaDevices: {
          getDisplayMedia: vi.fn(),
        },
      } as unknown as Navigator;

      const availability = screenCaptureAvailability(mockNavigator);
      expect(availability).toBe('navigator.mediaDevices.getDisplayMedia');
    });

    it('returns "missing" when getDisplayMedia is unavailable', () => {
      const mockNavigator = {
        mediaDevices: {},
      } as unknown as Navigator;

      const availability = screenCaptureAvailability(mockNavigator);
      expect(availability).toBe('missing');
    });

    it('returns "missing" when mediaDevices is unavailable', () => {
      const mockNavigator = {} as unknown as Navigator;

      const availability = screenCaptureAvailability(mockNavigator);
      expect(availability).toBe('missing');
    });
  });

  describe('isScreenCaptureAvailable', () => {
    it('returns true when getDisplayMedia is available', () => {
      const mockNavigator = {
        mediaDevices: {
          getDisplayMedia: vi.fn(),
        },
      } as unknown as Navigator;

      const available = isScreenCaptureAvailable(mockNavigator);
      expect(available).toBe(true);
    });

    it('returns false when getDisplayMedia is unavailable', () => {
      const mockNavigator = {
        mediaDevices: {},
      } as unknown as Navigator;

      const available = isScreenCaptureAvailable(mockNavigator);
      expect(available).toBe(false);
    });
  });
});
