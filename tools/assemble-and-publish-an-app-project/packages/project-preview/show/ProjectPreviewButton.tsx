import { useState } from 'react';
import { ExternalLink, Loader, Play, RefreshCw } from 'lucide-react';
import { Button, Icon, Text } from '@/packages/ui';
import { openProjectPreviewUrl } from '@/packages/project-preview/do-work/open-project-preview-url';
import { refreshProjectPreviewStatus } from '@/packages/project-preview/do-work/refresh-project-preview-status';
import { showProjectPreview } from '@/packages/project-preview/do-work/show-project-preview';
import { startProjectPreview } from '@/packages/project-preview/do-work/start-project-preview';
import type { ProjectPreviewDescriptor } from '@/packages/project-preview/read-data/read-project-preview-descriptors';

export interface ProjectPreviewButtonProps {
  preview: ProjectPreviewDescriptor;
}

export function ProjectPreviewButton({ preview }: ProjectPreviewButtonProps) {
  const [isOpening, setIsOpening] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  async function handleOpen() {
    setIsOpening(true);
    try {
      if (preview.command) {
        await startProjectPreview(preview);
      } else {
        await showProjectPreview(preview);
      }
      setHasOpened(true);
    } finally {
      setIsOpening(false);
    }
  }

  async function handleRefresh() {
    if (!preview.statusProbe) return;
    setIsOpening(true);
    try {
      await refreshProjectPreviewStatus(preview);
    } finally {
      setIsOpening(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Button onClick={handleOpen} disabled={isOpening} variant="accent" size="sm">
        <Icon icon={isOpening ? Loader : hasOpened ? ExternalLink : Play} size="xs" />
        <Text variant="body">{isOpening ? 'Working...' : hasOpened ? 'Show Preview' : preview.command ? 'Start Preview' : 'Preview'}</Text>
      </Button>
      {preview.statusProbe ? (
        <Button
          onClick={handleRefresh}
          disabled={isOpening}
          variant="ghost"
          size="icon"
          aria-label={`Refresh ${preview.name} preview status`}
        >
          <Icon icon={RefreshCw} size="xs" />
        </Button>
      ) : null}
      <Button
        onClick={() => openProjectPreviewUrl(preview)}
        disabled={isOpening}
        variant="ghost"
        size="icon"
        aria-label={`Open ${preview.name} externally`}
      >
        <Icon icon={ExternalLink} size="xs" />
      </Button>
    </div>
  );
}
