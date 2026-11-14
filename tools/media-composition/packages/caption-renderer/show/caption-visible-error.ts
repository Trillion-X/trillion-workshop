import { sanitizeErrorText } from '@/packages/ui/show/safe-error-card';

export function visibleCaptionError(message: string | null): string | null {
  if (!message) return null;
  if (message.includes('CarrierFrame websocket failed to open') || message.includes('CarrierFrame transport closed')) {
    return 'The connection dropped while sending the file. Choose it again.';
  }
  return sanitizeErrorText(message, 'This could not be completed. Try again.');
}
