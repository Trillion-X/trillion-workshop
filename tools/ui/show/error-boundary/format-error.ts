// packages/ui/show/error-boundary/format-error.ts
//
// Pure formatting helpers for browser-local React error boundaries.

export function formatErrorForDisplay(zoneName: string, error: Error): string {
  void zoneName;
  void error;
  return 'This screen hit a problem.';
}

export function displayZoneName(zoneName: string): string {
  return zoneName.replace(/\s+material$/i, '').trim() || 'This screen';
}

export function logBoundaryError(
  zoneName: string,
  error: Error,
  componentStack: string | null,
): void {
  console.error(
    `[ErrorBoundary] ${zoneName} caught an error:\n`,
    error,
    componentStack ? `\nComponent Stack:\n${componentStack}` : '',
  );
}
