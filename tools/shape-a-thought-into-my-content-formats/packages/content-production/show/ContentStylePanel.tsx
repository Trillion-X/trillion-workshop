/**
 * file: packages/content-production/show/ContentStylePanel.tsx
 *
 * PURPOSE: The Style picker surface (plan §13A U03). One Fey/Codex-style card
 * per style, where a style IS a run-profile record from the evidence feed.
 * Picking a style places the Make-content surface with that profile selected
 * via the generic placeable-surface intent — the same handoff the Library uses.
 *
 * NON-NEGOTIABLE INVARIANTS:
 * 1. Zero imports from slot::workflow or slot::eeaf — reads only via useBitfieldData
 * 2. Components only from @/packages/ui; zero inline style objects
 * 3. Styles are DATA (run-profile records) — this panel never names a style
 * 4. Observability: logs `[ui:content-style] mounted input=<n> records` on mount
 */

import * as React from 'react';

import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Wand2 } from 'lucide-react';

import {
  Badge,
  Button,
  Card,
  Container,
  Icon,
  ScrollableSurface,
  Text,
  emitPlaceableSurfaceIntent,
} from '@/packages/ui';

import {
  outputRoleLabel,
  readContentStyleOptions,
  type ContentStyleOption,
} from '@/packages/content-production/read-data/read-content-styles';

/** Place the Make-content surface with this style's run-profile selected. */
function makeContentWithStyle(style: ContentStyleOption): boolean {
  return emitPlaceableSurfaceIntent({
    id: 'content-production.panel',
    title: 'Make content',
    target: null,
    packageEntry: { packageName: 'content-production', entryName: 'content-production' },
    materialTarget: 'content-production',
    surfaceInput: {
      run_profile_id: style.profileId,
      execution_definition_id: style.executionDefinitionId,
    },
  });
}

export function ContentStylePanel() {
  const evidenceRows = useBitfieldData('content-production:contentMediaEvidence');
  const styles = React.useMemo(() => readContentStyleOptions(evidenceRows), [evidenceRows]);

  React.useEffect(() => {
    console.log(`[ui:content-style] mounted input=${styles.length} records`);
  }, [styles.length]);

  return (
    <ScrollableSurface>
      <Container layout="vertical" gap="lg" padding="lg" height="full">
        <Container layout="vertical" gap="xs">
          <Text variant="heading-lg">Style</Text>
          <Text variant="label">How your content gets made. Pick one to start.</Text>
        </Container>

        {styles.length === 0 ? (
          <Container layout="vertical" gap="xs" padding="xl" alignItems="center">
            <Text variant="body" color="secondary">No styles yet.</Text>
            <Text variant="label">Styles appear here as soon as a style is published.</Text>
          </Container>
        ) : (
          <Container layout="grid" gridCols="auto-fill-sm" gap="md">
            {styles.map((style) => (
              <Card key={style.profileId} variant="surface" padding="lg" layout="stack" interactive>
                <Container layout="vertical" gap="xs">
                  <Text variant="heading">{style.label}</Text>
                  <Container layout="horizontal" gap="xs" wrap>
                    {style.outputRoles.map((role) => (
                      <Badge key={role} variant="neutral" size="sm">
                        {outputRoleLabel(role)}
                      </Badge>
                    ))}
                  </Container>
                </Container>
                <Container layout="horizontal" gap="sm" alignItems="center">
                  <Button variant="primary" size="sm" onClick={() => makeContentWithStyle(style)}>
                    <Icon icon={Wand2} size="sm" />
                    Use this style
                  </Button>
                </Container>
              </Card>
            ))}
          </Container>
        )}
      </Container>
    </ScrollableSurface>
  );
}
