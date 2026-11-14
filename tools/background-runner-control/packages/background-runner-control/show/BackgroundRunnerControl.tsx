// packages/background-runner-control/show/BackgroundRunnerControl.tsx
//
// Read-only background runner evidence surface. Product startup and process
// ownership live in app-open/runtime activation; this package does not start,
// stop, or toggle execution.

import React from 'react';
import { Bot, Sparkles } from 'lucide-react';
import { Badge, Container, Divider, Icon, StatusDot, Text } from '@/packages/ui';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import {
  decodeBackgroundRunnerCliRegistryFeed,
} from '@/packages/background-runner-control/read-data/read-background-runner-cli-registry';
import {
  getBackgroundRunnerCliDefaultModelId,
  getBackgroundRunnerCliModels,
} from '@/packages/background-runner-control/read-data/background-runner-cli-models';
import {
  decodeBackgroundRunnerStatusFeed,
} from '@/packages/background-runner-control/read-data/read-background-runner-status';

export interface BackgroundRunnerControlProps {
  onProjectChange?: (project: string) => void;
}

export function BackgroundRunnerControl(_props: BackgroundRunnerControlProps) {
  const statusEntry = useBitfieldData();
  const status = React.useMemo(
    () => decodeBackgroundRunnerStatusFeed(statusEntry),
    [statusEntry],
  );
  const cliRegistryEntry = useBitfieldData('execution-options');
  const clis = React.useMemo(
    () => decodeBackgroundRunnerCliRegistryFeed(cliRegistryEntry),
    [cliRegistryEntry],
  );

  return (
    <Container layout="vertical" gap="sm">
      <Container layout="horizontal" gap="sm" alignItems="center" wrap={true}>
        <Container layout="horizontal" gap="xs" alignItems="center">
          <StatusDot status={status.running ? 'success' : 'idle'} size="sm" />
          <Text variant="label" color={status.running ? 'default' : 'faint'}>
            {status.running ? 'Runner Running' : 'Runner Stopped'}
          </Text>
        </Container>

        <Container layout="horizontal" gap="xs" alignItems="center">
          <Text variant="label" color="faint">Queue:</Text>
          <Badge variant={status.queueDepth > 0 ? 'neutral' : 'muted'}>
            {status.queueDepth}/{status.maxConcurrentExecutions}
          </Badge>
        </Container>

        {status.executingTasks.length > 0 && (
          <Container layout="horizontal" gap="xs" alignItems="center">
            <Text variant="label" color="faint">Executing:</Text>
            {status.executingTasks.map((taskId) => (
              <Badge key={taskId} variant="muted">
                {taskId}
              </Badge>
            ))}
          </Container>
        )}

        <Container layout="horizontal" gap="xs" alignItems="center">
          <Text variant="label" color="faint">
            {status.loopsCompleted} loops - {status.tasksExecuted} executed
          </Text>
        </Container>
      </Container>

      <Divider size="sm" />

      <Container layout="horizontal" gap="sm" alignItems="center" wrap={true}>
        {clis.length === 0 ? (
          <Text variant="label" color="faint">No runner CLI evidence published.</Text>
        ) : (
          clis.map((cli) => {
            const defaultModel = getBackgroundRunnerCliDefaultModelId(clis, cli.cli);
            const modelCount = getBackgroundRunnerCliModels(clis, cli.cli).length;
            return (
              <Container key={cli.cli} layout="horizontal" gap="xs" alignItems="center">
                <Icon icon={Bot} size="sm" />
                <Text variant="label">{cli.displayName}</Text>
                <Badge variant="muted">{modelCount} models</Badge>
                {defaultModel ? (
                  <>
                    <Icon icon={Sparkles} size="xs" />
                    <Text variant="caption" color="faint">{defaultModel}</Text>
                  </>
                ) : null}
              </Container>
            );
          })
        )}
      </Container>
    </Container>
  );
}
