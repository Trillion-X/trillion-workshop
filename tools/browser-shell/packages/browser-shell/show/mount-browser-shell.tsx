// package-set://bitfield-studio/packages/browser-shell/show/mount-browser-shell.tsx
//
// Composition Engine mount adapter for component:browser-shell.
// This file receives a raw DOM element from the renderer and delegates only
// React root lifecycle to the pure browser-local mount primitive. It must not
// import or mount sibling Bitfield Studio surfaces.

import React from 'react';
import { mountReactSurface } from '@/packages/ui';
import BrowserShell from './BrowserShell';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
  theme?: Record<string, unknown>;
};

type RootErrorBoundaryProps = {
  children: React.ReactNode;
};

type RootErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
};

class RootErrorBoundary extends React.Component<
  RootErrorBoundaryProps,
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = {
    hasError: false,
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { hasError: true, error, componentStack: null };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('[component:browser-shell] root render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100%',
            padding: '24px',
            background: '#0a0a0a',
            color: '#e5e5e5',
            fontFamily: 'system-ui, sans-serif',
            gap: '12px',
          },
        },
        React.createElement(
          'div',
          { style: { fontSize: '20px', color: '#ef4444' } },
          'Browser Shell Error',
        ),
        React.createElement(
          'div',
          {
            style: {
              fontSize: '14px',
              opacity: 0.8,
              textAlign: 'center',
              maxWidth: '640px',
            },
          },
          this.state.error.message,
        ),
        this.state.componentStack
          ? React.createElement(
              'pre',
              {
                style: {
                  maxWidth: '640px',
                  maxHeight: '240px',
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  fontSize: '12px',
                  background: '#1a1a1a',
                  padding: '12px',
                  borderRadius: '8px',
                },
              },
              this.state.componentStack,
            )
          : null,
      );
    }

    return this.props.children;
  }
}

export default function mount({ el, props = {}, theme = {} }: MountArgs) {
  const componentProps =
    Object.keys(theme).length > 0 ? { ...props, theme } : props;

  return mountReactSurface(
    el,
    React.createElement(
      RootErrorBoundary,
      null,
      React.createElement(BrowserShell, componentProps),
    ),
  );
}
