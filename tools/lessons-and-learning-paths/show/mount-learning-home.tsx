import React from 'react';
import { BookOpen, Map } from 'lucide-react';
import {
  Button,
  Container,
  ErrorBoundary,
  FloatingMaterialFrame,
  PlaceableSurfaceHost,
  Text,
  mountReactSurface,
} from '@/packages/ui';
import { ToastProvider } from '@/packages/ui/show/toast';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

type EmbeddedSurface = {
  package_entry?: { package_name?: string; entry_name?: string };
  material_target?: string;
  target?: string;
  surface_input?: Record<string, unknown>;
};

type LearningHomeInput = {
  lessons_surface?: EmbeddedSurface;
  path_surface?: EmbeddedSurface;
};

function EmbeddedStage({ descriptor }: { descriptor: EmbeddedSurface | undefined }) {
  if (!descriptor?.package_entry?.package_name || !descriptor.package_entry.entry_name || !descriptor.material_target) {
    return (
      <Container flex={1} minHeight="0" alignItems="center" justifyContent="center" border="all" rounded="lg">
        <Text variant="body" color="secondary">This learning view is not available right now.</Text>
      </Container>
    );
  }
  return (
    <Container as="main" flex={1} minHeight="0" overflow="hidden" border="all" rounded="lg">
      <PlaceableSurfaceHost
        packageName={descriptor.package_entry.package_name}
        entryName={descriptor.package_entry.entry_name}
        materialTarget={descriptor.material_target}
        target={descriptor.target}
        surfaceInput={descriptor.surface_input}
        fill
        interactive
      />
    </Container>
  );
}

function LearningHomeMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInput = (props.surfaceInput ?? props.surface_input ?? {}) as LearningHomeInput;
  const [view, setView] = React.useState<'lessons' | 'path'>('lessons');
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="learning home material">
        <ToastProvider>
          <Container as="section" data-package="learning-home" layout="vertical" gap="sm" padding="sm" height="full" minHeight="0" width="full" overflow="hidden">
            <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap>
              <Container layout="vertical" gap="xs">
                <Text variant="caption" color="muted" weight="semibold">LEARN</Text>
                <Text variant="heading-lg" color="strong">Learning</Text>
              </Container>
              <Container layout="horizontal" gap="xs" role="group" aria-label="Learning view">
                <Button variant="secondary" size="sm" active={view === 'lessons'} onClick={() => setView('lessons')}>
                  <BookOpen aria-hidden="true" size={16} /> Lessons
                </Button>
                <Button variant="secondary" size="sm" active={view === 'path'} onClick={() => setView('path')}>
                  <Map aria-hidden="true" size={16} /> Path
                </Button>
              </Container>
            </Container>
            <EmbeddedStage descriptor={view === 'lessons' ? surfaceInput.lessons_surface : surfaceInput.path_surface} />
          </Container>
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <LearningHomeMaterial props={props} />);
}
