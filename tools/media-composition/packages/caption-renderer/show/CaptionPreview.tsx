import React from 'react';
import { Captions, Film } from 'lucide-react';

import { Card } from '@/packages/ui/show/card';
import { FilePreview } from '@/packages/ui/show/file-preview/FilePreview';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import type { CaptionTimingPreview } from '@/packages/caption-renderer/read-data/caption-renderer-types';

export function CaptionPreview({
  timing,
  videoUrl = null,
  rendering = false,
  outputPath = null,
}: {
  timing: CaptionTimingPreview | null;
  videoUrl?: string | null;
  rendering?: boolean;
  outputPath?: string | null;
}) {
  const previewText = timing?.samples.length ? timing.samples.slice(0, 8) : ['choose', 'audio', 'make', 'captions'];
  const activeIndex = Math.min(2, previewText.length - 1);

  return (
    <Card variant="surface" padding="lg" layout="stack" className="overflow-hidden">
      <Container layout="horizontal" alignItems="center" justifyContent="between" gap="md">
        <Container layout="vertical" gap="xs" minHeight="0">
          <Text variant="heading">Preview</Text>
          <Text variant="caption" color="faint" truncate>
            {outputPath ?? (timing?.count ? `${timing.count} captions ready` : 'Captions appear here before the video is made.')}
          </Text>
        </Container>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-status-success/15 text-status-success">
          {videoUrl ? <Film className="h-5 w-5" /> : <Captions className="h-5 w-5" />}
        </span>
      </Container>

      {videoUrl ? (
        <div className="aspect-video w-full overflow-hidden rounded-[28px] bg-black shadow-2xl">
          <FilePreview url={videoUrl} contentType="video/mp4" label="Captioned video" autoPlay={false}/>
        </div>
      ) : (
        <div className="relative flex min-h-[280px] items-end justify-center overflow-hidden rounded-[32px] border border-[var(--border-primary)] bg-[radial-gradient(circle_at_18%_14%,var(--glass-bg-hover),transparent_24%),linear-gradient(140deg,var(--surface-base),var(--glass-bg-primary))] p-8 shadow-2xl">
          <div className="absolute left-5 top-5 flex items-center gap-2 rounded-full border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-3 py-1 text-xs text-[var(--text-secondary)]">
            <Captions className="h-3.5 w-3.5" />
            {rendering ? 'rendering' : 'caption look'}
          </div>
          <p className="flex max-w-[34rem] flex-wrap justify-center gap-x-3 gap-y-2 text-center text-[clamp(2rem,4.2vw,4.5rem)] font-semibold leading-[0.95] tracking-tight">
            {previewText.map((word, index) => (
              <span
                key={`${word}-${index}`}
                className={index <= activeIndex ? 'text-[var(--text-primary)]' : index > activeIndex + 3 ? 'text-[var(--text-muted)] opacity-45' : 'text-[var(--text-secondary)]'}
              >
                {word}
              </span>
            ))}
          </p>
        </div>
      )}
    </Card>
  );
}
