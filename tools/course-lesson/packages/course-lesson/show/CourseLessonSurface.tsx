import React from 'react';
import { BookOpen, CheckCircle2, Download, ExternalLink } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Container,
  downloadBlob,
  FilePreview,
  ScrollableSurface,
  Text,
} from '../../../../ui';

export type CourseResource = {
  id: string;
  label: string;
  url: string;
  media_type: string;
  byte_length?: number;
  file_name?: string;
};

export type CourseLessonInput = {
  lesson_id?: string;
  title?: string;
  summary?: string;
  body?: string;
  do_now?: string;
  primary_resource_id?: string;
  resources?: CourseResource[];
};

export type LessonBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; text: string }
  | { kind: 'code'; text: string };

export function parseLessonBody(source: string): LessonBlock[] {
  const blocks: LessonBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] = [];
  let inCode = false;
  const flushParagraph = () => {
    const text = paragraph.join(' ').trim();
    if (text) blocks.push({ kind: 'paragraph', text });
    paragraph = [];
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (line.trim().startsWith('```')) {
      if (inCode) {
        blocks.push({ kind: 'code', text: code.join('\n') });
        code = [];
      } else flushParagraph();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (heading) {
      flushParagraph();
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] });
      continue;
    }
    const list = /^[-*]\s+(.+)$/.exec(line.trim());
    if (list) {
      flushParagraph();
      blocks.push({ kind: 'list', text: list[1] });
      continue;
    }
    if (!line.trim()) flushParagraph();
    else paragraph.push(line.trim());
  }
  flushParagraph();
  if (code.length) blocks.push({ kind: 'code', text: code.join('\n') });
  return blocks;
}

function readableBytes(value?: number): string {
  if (!value || value < 1) return '';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function ResourceCard({ resource }: { resource: CourseResource }) {
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);
  const [state, setState] = React.useState<'idle' | 'loading' | 'error'>('idle');

  React.useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const fetchBlob = React.useCallback(async () => {
    const response = await fetch(resource.url);
    if (!response.ok) throw new Error(`resource request failed: ${response.status}`);
    const source = await response.blob();
    return new Blob([source], { type: resource.media_type || source.type || 'application/octet-stream' });
  }, [resource.media_type, resource.url]);

  const preview = React.useCallback(async () => {
    setState('loading');
    try {
      const blob = await fetchBlob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
      setState('idle');
    } catch {
      setState('error');
    }
  }, [fetchBlob, previewUrl]);

  const download = React.useCallback(async () => {
    setState('loading');
    try {
      const blob = await fetchBlob();
      downloadBlob(blob, resource.file_name || resource.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'course-resource');
      setState('idle');
    } catch {
      setState('error');
    }
  }, [fetchBlob, resource.file_name, resource.label]);

  return (
    <Card variant="nested" padding="md">
      <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap>
        <Container layout="vertical" gap="xs" minWidth="0">
          <Container layout="horizontal" gap="xs" alignItems="center">
            <BookOpen aria-hidden="true" size={18} />
            <Text variant="body" color="strong" weight="semibold">{resource.label}</Text>
          </Container>
          <Text variant="body-sm" color="muted">
            {resource.media_type === 'application/pdf' ? 'PDF' : resource.media_type}{readableBytes(resource.byte_length) ? ` · ${readableBytes(resource.byte_length)}` : ''}
          </Text>
        </Container>
        <Container layout="horizontal" gap="sm" wrap>
          <Button variant="secondary" size="sm" onClick={() => void preview()} disabled={state === 'loading'}>
            <ExternalLink aria-hidden="true" size={16} /> Read in app
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void download()} disabled={state === 'loading'}>
            <Download aria-hidden="true" size={16} /> Download
          </Button>
        </Container>
      </Container>
      {state === 'error' ? <Text variant="body-sm" color="secondary">This resource could not open. Try again.</Text> : null}
      {previewUrl ? (
        <Container className="mt-3 overflow-hidden rounded-lg border border-[var(--border-subtle)]" style={{ height: 'min(78vh, 60rem)', minHeight: '36rem' }}>
          <FilePreview url={previewUrl} contentType={resource.media_type} label={resource.label} autoPlay={false} />
        </Container>
      ) : null}
    </Card>
  );
}

function PrimaryResource({ resource }: { resource: CourseResource }) {
  const [state, setState] = React.useState<'idle' | 'loading' | 'error'>('idle');
  const [previewUrl, setPreviewUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    void (async () => {
      try {
        const response = await fetch(resource.url);
        if (!response.ok) throw new Error(`resource request failed: ${response.status}`);
        const source = await response.blob();
        const typedPdf = new Blob([source], { type: resource.media_type || source.type || 'application/pdf' });
        objectUrl = URL.createObjectURL(typedPdf);
        if (!cancelled) setPreviewUrl(objectUrl);
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [resource.media_type, resource.url]);

  const download = React.useCallback(async () => {
    setState('loading');
    try {
      const response = await fetch(resource.url);
      if (!response.ok) throw new Error(`resource request failed: ${response.status}`);
      const source = await response.blob();
      const blob = new Blob([source], { type: resource.media_type || source.type || 'application/octet-stream' });
      downloadBlob(blob, resource.file_name || `${resource.id}.pdf`);
      setState('idle');
    } catch {
      setState('error');
    }
  }, [resource]);

  return (
    <Container as="section" layout="vertical" gap="sm" aria-label="Full lesson">
      <Container layout="horizontal" gap="md" alignItems="center" justifyContent="between" wrap>
        <Container layout="vertical" gap="xs">
          <Text variant="heading-md" color="strong">Full lesson</Text>
          <Text variant="body-sm" color="secondary">Read the complete learner guide here. It changes with each lesson.</Text>
        </Container>
        <Container layout="horizontal" gap="sm" wrap>
          <a
            href={resource.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-2 text-sm font-semibold text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]"
          >
            <ExternalLink aria-hidden="true" size={16} /> Open PDF
          </a>
          <Button variant="secondary" size="sm" onClick={() => void download()} disabled={state === 'loading'}>
            <Download aria-hidden="true" size={16} /> {state === 'loading' ? 'Preparing…' : 'Download'}
          </Button>
        </Container>
      </Container>
      <Container overflow="hidden" rounded="lg" border="all" style={{ height: 'min(78vh, 60rem)', minHeight: '36rem' }}>
        {previewUrl ? (
          <iframe
            src={previewUrl}
            title={`${resource.label} lesson PDF`}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <Container height="full" width="full" alignItems="center" justifyContent="center">
            <Text variant="body" color="secondary">{state === 'error' ? 'Use Open PDF while the preview reconnects.' : 'Opening the full lesson…'}</Text>
          </Container>
        )}
      </Container>
      {state === 'error' ? <Text variant="body-sm" color="secondary">The download could not start. You can still use Open PDF.</Text> : null}
    </Container>
  );
}

export function CourseLessonSurface({ input }: { input: CourseLessonInput }) {
  const blocks = React.useMemo(() => parseLessonBody(input.body ?? ''), [input.body]);
  const resources = Array.isArray(input.resources) ? input.resources.filter((item) => item?.id && item?.url) : [];
  const primaryResource = resources.find((resource) => resource.id === input.primary_resource_id)
    ?? resources.find((resource) => resource.media_type === 'application/pdf')
    ?? null;
  const supportingResources = primaryResource
    ? resources.filter((resource) => resource.id !== primaryResource.id)
    : resources;
  return (
    <ScrollableSurface>
      <Container as="article" layout="vertical" gap="lg" width="full" className="mx-auto max-w-4xl" data-course-lesson={input.lesson_id ?? 'lesson'}>
        <Container layout="vertical" gap="sm">
          <Badge variant="info" size="sm">Course lesson</Badge>
          <Text variant="heading-xl" color="strong" leading="tight">{input.title || 'Lesson'}</Text>
          {input.summary ? <Text variant="body-lg" color="secondary">{input.summary}</Text> : null}
        </Container>

        {primaryResource ? <PrimaryResource resource={primaryResource} /> : null}

        {blocks.length ? (
          <Container as="section" layout="vertical" gap="md" aria-label="Lesson notes">
            {primaryResource ? <Text variant="heading-md" color="strong">Lesson notes</Text> : null}
            {blocks.map((block, index) => {
              if (block.kind === 'heading') return <Text key={index} variant={block.level === 1 ? 'heading-lg' : block.level === 2 ? 'heading-md' : 'heading'} color="strong">{block.text}</Text>;
              if (block.kind === 'list') return <Text key={index} variant="body" color="secondary">• {block.text}</Text>;
              if (block.kind === 'code') return <Card key={index} variant="nested" padding="md"><Text variant="body-sm" className="whitespace-pre-wrap font-mono">{block.text}</Text></Card>;
              return <Text key={index} variant="body" color="secondary" className="whitespace-pre-wrap">{block.text}</Text>;
            })}
          </Container>
        ) : (
          <Card variant="nested" padding="md"><Text variant="body" color="secondary">This lesson is being prepared.</Text></Card>
        )}

        {input.do_now ? (
          <Card variant="surface" padding="lg">
            <Container layout="horizontal" gap="sm" alignItems="start">
              <CheckCircle2 aria-hidden="true" />
              <Container layout="vertical" gap="xs">
                <Text variant="heading" color="strong">Try this now</Text>
                <Text variant="body" color="secondary">{input.do_now}</Text>
              </Container>
            </Container>
          </Card>
        ) : null}

        {supportingResources.length ? (
          <Container layout="vertical" gap="sm">
            <Text variant="heading-md" color="strong">More resources</Text>
            {supportingResources.map((resource) => <ResourceCard key={resource.id} resource={resource} />)}
          </Container>
        ) : null}
      </Container>
    </ScrollableSurface>
  );
}
