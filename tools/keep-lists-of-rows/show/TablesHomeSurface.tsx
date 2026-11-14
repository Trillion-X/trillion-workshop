//
// The Tables home: browse every table this package published (from the shared
// records feed) and create a new one. Browsing is a PickerTile grid; opening a
// table emits the shared placeable-surface intent (the screen arrangement
// decides the tab); creating writes ONE table-config DATA row through the
// package's record writer — the same row shape the authored table-configs use,
// so created and authored tables are indistinguishable.
//
// This surface names no table, no field, no domain (L090): the catalog is a
// structural read (placeable surfaces with field descriptors), and a new table
// is a generic starter row the user grows on the open board.

import React from 'react';
import {
  Button,
  Container,
  Input,
  PickerTile,
  Text,
  emitPlaceableSurfaceIntent,
  useToastContext,
} from '@/packages/ui';
import {
  buildNewTableWrite,
  openTablePayload,
  readTableCatalog,
  type TableCatalogEntry,
} from '@/packages/visual-database/show/tables-home-model';

export interface TablesHomeSurfaceProps {
  records: unknown;
  packageName: string;
  entryName: string;
  writeTable: (write: { addressLabel: string; payload: unknown }) => Promise<void>;
}

function TableTile({ entry }: { entry: TableCatalogEntry }) {
  const openTable = React.useCallback(() => {
    emitPlaceableSurfaceIntent(openTablePayload(entry.surface));
  }, [entry.surface]);
  return (
    <PickerTile
      title={entry.surface.label}
      subtitle={`${entry.fieldCount} fields · ${entry.viewCount} views`}
      icon={entry.surface.icon ?? 'Table'}
      onClick={openTable}
    />
  );
}

export function TablesHomeSurface({ records, packageName, entryName, writeTable }: TablesHomeSurfaceProps) {
  const { showSuccess, showError } = useToastContext();
  const [query, setQuery] = React.useState('');
  const [draftName, setDraftName] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const catalog = React.useMemo(
    () => readTableCatalog(records, packageName),
    [records, packageName],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const visible = React.useMemo(
    () => (normalizedQuery
      ? catalog.filter((entry) => entry.surface.label.toLowerCase().includes(normalizedQuery))
      : catalog),
    [catalog, normalizedQuery],
  );

  const createTable = React.useCallback(async () => {
    const write = buildNewTableWrite(draftName, catalog, packageName, entryName);
    if (!write) return;
    setCreating(true);
    try {
      await writeTable(write);
      showSuccess(`Created ${draftName.trim()}`);
      setDraftName('');
      emitPlaceableSurfaceIntent(openTablePayload({
        id: String(write.payload.id),
        label: String(write.payload.label),
        icon: 'Table',
        materialTarget: String(write.payload.material_target),
        packageEntry: { packageName, entryName },
        order: 0,
        routePaths: [],
        routePrefixes: [],
        acceptsMaterialKinds: [],
        surfaceInput: write.payload.surface_input as Record<string, unknown>,
        payload: write.payload,
      }));
    } catch (error) {
      console.error('[TablesHome] create failed', error);
      showError('Could not create the table.');
    } finally {
      setCreating(false);
    }
  }, [catalog, draftName, entryName, packageName, showError, showSuccess, writeTable]);

  const draftReady = buildNewTableWrite(draftName, catalog, packageName, entryName) !== null;

  return (
    <Container layout="vertical" gap="md" padding="lg" scroll="vertical" fullHeight>
      <Container layout="horizontal" gap="md" align="center" justify="between" wrap>
        <Container layout="vertical" gap="xs">
          <Text variant="heading" size="lg">Tables</Text>
          <Text variant="body" color="muted">
            {catalog.length === 1 ? '1 table' : `${catalog.length} tables`}
          </Text>
        </Container>
        <Container layout="horizontal" gap="sm" align="center" wrap>
          <Input
            value={draftName}
            onChange={(event) => setDraftName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && draftReady && !creating) void createTable();
            }}
            placeholder="New table name"
            aria-label="New table name"
          />
          <Button
            type="button"
            variant="primary"
            disabled={!draftReady || creating}
            onClick={() => void createTable()}
            data-reach-action="create-table"
          >
            {creating ? 'Creating…' : 'Create table'}
          </Button>
        </Container>
      </Container>
      {catalog.length > 3 ? (
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Filter tables"
          aria-label="Filter tables"
        />
      ) : null}
      <Container layout="vertical" gap="sm" data-reach-role="table-browser">
        {visible.length > 0 ? (
          <Container layout="grid" gap="sm" gridCols="auto-fill-xs">
            {visible.map((entry) => (
              <TableTile key={entry.surface.id} entry={entry} />
            ))}
          </Container>
        ) : (
          <Container layout="vertical" gap="xs" align="center" padding="lg">
            <Text variant="body" color="muted">
              {catalog.length === 0
                ? 'No tables yet. Name one above to create it.'
                : 'No tables match that filter.'}
            </Text>
          </Container>
        )}
      </Container>
    </Container>
  );
}
