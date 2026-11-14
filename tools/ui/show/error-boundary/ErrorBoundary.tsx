// packages/ui/show/error-boundary/ErrorBoundary.tsx
//
// Pure browser-local React error boundary. It owns no data source, target
// invoke, durable state, or feature meaning; callers provide the zone label.

import React, { Component } from 'react';
import type { ErrorInfo } from 'react';
import { ScreenState } from '../screen-state/ScreenState';
import type { ErrorBoundaryState, ErrorBoundaryProps } from './types';
import { formatErrorForDisplay, logBoundaryError } from './format-error';

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const stack = errorInfo.componentStack ?? null;
    this.setState({ componentStack: stack });
    logBoundaryError(this.props.zoneName, error, stack);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  render() {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.handleRetry);
      }

      // The person reads the shared failed state in plain words with Try again; the zone, the error and its stacks go
      // only to the console (componentDidCatch), never to the screen.
      return (
        <ScreenState state={{ status: 'failed', title: formatErrorForDisplay(this.props.zoneName, this.state.error), retry: { label: 'Try again', run: this.handleRetry } }} />
      );
    }

    return this.props.children;
  }
}
