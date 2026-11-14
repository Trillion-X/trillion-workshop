// packages/learning-path/show/LearningPathSurface.tsx
// A generic winding node path over a learner journey. Thin — it builds the screen model and renders the shared
// PathRail primitive. ui/ components only; no domain logic, no status enum.

import * as React from 'react';
import { Award, BookOpen, Dumbbell, Gift, Headphones, Mic, Star, Trophy, Video } from 'lucide-react';

import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import { PathRail, type PathNodeView } from '@/packages/ui/show/path-rail';
import { ScrollableSurface } from '@/packages/ui/show/scrollable-surface';
import {
  buildLearningPathScreenModel,
  type LearningPathScreenModel,
} from '../read-data/learning-path-screen-model';
import {
  buildLearningPathFromSources,
  type LearningPathSources,
} from '../read-data/build-from-sources';

// Icon registry (name -> component). Adding an icon is one entry; the path layer
// never names these. Unknown / missing falls back to a star.
const ICONS: Readonly<Record<string, PathNodeView['icon']>> = {
  star: Star,
  lesson: Star,
  book: BookOpen,
  reading: BookOpen,
  audio: Headphones,
  headphones: Headphones,
  speaking: Mic,
  mic: Mic,
  video: Video,
  film: Video,
  drill: Dumbbell,
  strength: Dumbbell,
  reward: Gift,
  chest: Gift,
  milestone: Trophy,
  trophy: Trophy,
  badge: Award,
};

function resolveIcon(iconName?: string): PathNodeView['icon'] {
  return (iconName && ICONS[iconName]) || Star;
}

function PathHeader({ title }: { title: string }) {
  if (!title) return null;
  return (
    <Card variant="surface" padding="md">
      <Text variant="overline" color="faint">Your path</Text>
      <Text variant="heading">{title}</Text>
    </Card>
  );
}

function EmptyState() {
  return (
    <Card variant="surface" padding="lg">
      <Container layout="vertical" gap="xs" alignItems="center">
        <Text variant="heading">Your path is being built</Text>
        <Text variant="body" color="muted">Your lessons and milestones will appear here as your plan is set up.</Text>
      </Container>
    </Card>
  );
}

export function LearningPathSurface({
  model,
  onActivate,
}: {
  model: LearningPathScreenModel;
  // Called with node.id when an enabled level is tapped. Threading this is what
  // makes the coins clickable; without it PathNode renders every node inert.
  onActivate?: (id: string) => void;
}) {
  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="md" alignItems="stretch">
        <PathRail
          nodes={model.nodes}
          header={<PathHeader title={model.title} />}
          emptyState={<EmptyState />}
          onActivate={onActivate}
        />
      </Container>
    </ScrollableSurface>
  );
}

export function buildLearningPathSurfaceModel(raw: unknown): LearningPathScreenModel {
  return buildLearningPathScreenModel(raw, resolveIcon);
}

export function buildLearningPathSurfaceModelFromSources(sources: LearningPathSources): LearningPathScreenModel {
  return buildLearningPathFromSources(sources, resolveIcon);
}
