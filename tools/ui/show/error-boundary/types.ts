import type { ReactNode } from 'react';

export type ErrorBoundaryProps = {
  children: ReactNode;
  zoneName: string;
  fallback?: (error: Error, retry: () => void) => ReactNode;
};

export type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
};
