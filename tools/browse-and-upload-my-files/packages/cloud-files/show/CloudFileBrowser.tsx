import React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { Button, Card, Container, Text } from '@/packages/ui';
import {
  decodeCloudFileSources,
  type CloudFileSource,
} from '@/packages/cloud-files/read-data/read-cloud-file-sources';
import {
  readCloudDirectory,
  type CloudFileEntry,
} from '@/packages/cloud-files/read-data/read-cloud-directory';

function sourceLabel(source: CloudFileSource): string {
  return source.provider ? `${source.name} (${source.provider})` : source.name;
}

export function CloudFileBrowser() {
  const sourcesEntry = useBitfieldData();
  const sources = React.useMemo(
    () => decodeCloudFileSources(sourcesEntry),
    [sourcesEntry],
  );
  const [selectedSourceId, setSelectedSourceId] = React.useState<string>('');
  const [currentPath, setCurrentPath] = React.useState('');
  const [entries, setEntries] = React.useState<CloudFileEntry[]>([]);
  const [loadingDirectory, setLoadingDirectory] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const selectedSource = React.useMemo(
    () => sources.find((source) => source.id === selectedSourceId) ?? sources[0] ?? null,
    [selectedSourceId, sources],
  );

  React.useEffect(() => {
    if (selectedSource && !selectedSourceId) {
      setSelectedSourceId(selectedSource.id);
    }
  }, [selectedSource, selectedSourceId]);

  const loadDirectory = React.useCallback(async (source: CloudFileSource, path: string) => {
    setLoadingDirectory(true);
    setError(null);
    try {
      const nextEntries = await readCloudDirectory(source, path);
      setCurrentPath(path);
      setEntries(nextEntries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoadingDirectory(false);
    }
  }, []);

  React.useEffect(() => {
    if (!selectedSource) {
      setEntries([]);
      setCurrentPath('');
      return;
    }
    void loadDirectory(selectedSource, selectedSource.rootPath);
  }, [loadDirectory, selectedSource]);

  if (sourcesEntry === null) {
    return (
      <Card variant="nested" padding="md">
        <Text>Loading cloud file sources...</Text>
      </Card>
    );
  }

  if (sources.length === 0) {
    return (
      <Card variant="nested" padding="md" layout="stack">
        <Text variant="body" weight="medium">No cloud file sources published</Text>
        <Text variant="label" color="faint">
          Cloud providers are data-configured source records. This package does not
          hardcode Google Drive, Dropbox, S3, or any browser fetch path.
        </Text>
      </Card>
    );
  }

  return (
    <Container layout="vertical" gap="md" padding="none" height="full" minHeight="0">
      <Card variant="nested" padding="md" layout="stack">
        <Container layout="horizontal" gap="sm" wrap>
          {sources.map((source) => (
            <Button
              key={source.id}
              type="button"
              size="sm"
              variant="ghost"
              active={selectedSource?.id === source.id}
              onClick={() => setSelectedSourceId(source.id)}
            >
              {sourceLabel(source)}
            </Button>
          ))}
        </Container>
        <Container layout="horizontal" gap="sm" justifyContent="between" alignItems="center">
          <Text variant="label" color="faint">{currentPath || selectedSource?.rootPath || '/'}</Text>
          {selectedSource ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              loading={loadingDirectory}
              onClick={() => void loadDirectory(selectedSource, currentPath || selectedSource.rootPath)}
            >
              Refresh
            </Button>
          ) : null}
        </Container>
        {error ? <Text variant="label" color="danger">{error}</Text> : null}
      </Card>

      <Card variant="nested" padding="none" flex={1} minHeight="0">
        <Container layout="vertical" gap="none" padding="sm" overflow="y-auto" height="full">
          {entries.map((entry) => (
            <Button
              key={`${entry.id}:${entry.path}`}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (entry.isDir && selectedSource) void loadDirectory(selectedSource, entry.path);
              }}
            >
              {entry.isDir ? 'Folder' : 'File'}: {entry.name}
            </Button>
          ))}
          {!loadingDirectory && entries.length === 0 ? (
            <Text variant="label" color="faint">No entries returned by this source.</Text>
          ) : null}
        </Container>
      </Card>
    </Container>
  );
}
