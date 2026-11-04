// packages/group/show/ReducedTablePanel.tsx
//
// The BLIND panel for the reducer family — renders any `ReducedTable` (a census / pivot / histogram / crosstab
// output, all the same shape) as a readable breakdown where every group is a click-to-select control. It names
// no reducer and no facet: it iterates `table.sections`, draws a titled block per section, and one Button per
// group (its label + the aggregate as a Badge). A click hands the WHOLE group back — the caller selects + frames
// the cards the group holds. Read the breakdown, grab a slice. Distinct from Diversity (per-facet EVENNESS +
// the single dominant value): this shows the FULL distribution, every value clickable (L090 — data in, behavior
// injected). Renders an honest empty line when there is nothing to break down.
import { Badge, Button, Card, Container, Text } from '../../ui';
import type { ReducedGroup, ReducedTable } from '../read-data/reduced-table';

export interface ReducedTablePanelProps {
  readonly title: string;
  readonly table: ReducedTable;
  /** Called with the whole group when its row is clicked — the caller selects + frames `group.cardIds`. */
  readonly onPickGroup: (group: ReducedGroup) => void;
  readonly onClose: () => void;
}

export function ReducedTablePanel({ title, table, onPickGroup, onClose }: ReducedTablePanelProps): JSX.Element {
  return (
    <Card variant="popover" padding="md">
      <Container layout="vertical" gap="md" style={{ minWidth: 260, maxWidth: 340 }}>
        <Container layout="horizontal" gap="sm" alignItems="center">
          <Text variant="body-md" weight="semibold">{title}</Text>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close breakdown panel">Close</Button>
        </Container>
        {table.sections.length === 0 ? (
          <Text variant="body-sm">Nothing to break down yet.</Text>
        ) : (
          table.sections.map((section) => (
            <Container key={section.key} layout="vertical" gap="xs">
              <Text variant="label">{section.title}</Text>
              {section.groups.map((g) => (
                <Button
                  key={g.key}
                  variant="ghost"
                  size="sm"
                  aria-label={`Select the ${g.cardIds.length} cards where ${section.title} is ${g.label}`}
                  onClick={() => onPickGroup(g)}
                >
                  <Container layout="horizontal" gap="sm" alignItems="center">
                    <Text variant="body-sm">{g.label}</Text>
                    <Badge variant="neutral" size="sm">{g.detail}</Badge>
                  </Container>
                </Button>
              ))}
            </Container>
          ))
        )}
      </Container>
    </Card>
  );
}
