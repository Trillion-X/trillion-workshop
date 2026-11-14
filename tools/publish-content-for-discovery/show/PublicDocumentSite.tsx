import * as React from 'react';
import { useBitfieldData } from '@bitfield/runtime-kit/react';
import { ExternalLink } from 'lucide-react';
import { Container } from '@/packages/ui/show/container';
import { Icon } from '@/packages/ui/show/icon';
import { ScrollableSurface } from '@/packages/ui/show/scrollable-surface';
import { Text } from '@/packages/ui/show/text';
import {
  readPublicDocumentSiteModel,
  type PublicDocument,
  type PublicDocumentBlock,
} from '@/packages/public-document-site/read-data/read-public-document-site';

function blockText(block: PublicDocumentBlock): string {
  return block.body ?? block.text ?? '';
}

function DocumentBlock({ block }: { block: PublicDocumentBlock }) {
  const text = blockText(block);
  return (
    <section className="space-y-2 border-t border-[var(--border-primary)] pt-4">
      {block.heading ? <Text variant="heading-lg" className="text-base">{block.heading}</Text> : null}
      {text ? <Text variant="body" color="secondary" leading="relaxed">{text}</Text> : null}
      {block.items?.length ? (
        <ul className="list-disc space-y-1 pl-5 text-sm leading-7 text-[var(--text-secondary)]">
          {block.items.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

function DocumentPreview({ document }: { document: PublicDocument }) {
  const path = `/${document.slug.replace(/^\/+/, '')}`;
  return (
    <article className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface-primary)] p-5 shadow-sm">
      <a className="group inline-flex items-center gap-2" href={path}>
        <Text variant="heading-xl" className="text-xl">{document.title}</Text>
        <Icon icon={ExternalLink} size="sm" color="faint" />
      </a>
      <div className="mt-4 space-y-4">
        {document.blocks.slice(0, 3).map((block, index) => (
          <DocumentBlock key={block.id ?? `${document.id}-block-${index}`} block={block} />
        ))}
      </div>
      {document.faqPairs.length ? (
        <section className="mt-5 space-y-3 border-t border-[var(--border-primary)] pt-4">
          <Text variant="heading-lg" className="text-base">Questions</Text>
          {document.faqPairs.slice(0, 3).map((pair, index) => (
            <details key={`${document.id}-faq-${index}`} className="text-sm text-[var(--text-secondary)]">
              <summary className="cursor-pointer font-medium text-[var(--text-primary)]">{pair.question}</summary>
              <Text variant="body" color="secondary" leading="relaxed" className="pt-2">{pair.answer}</Text>
            </details>
          ))}
        </section>
      ) : null}
      {document.sources.length ? (
        <footer className="mt-5 flex flex-wrap gap-2 border-t border-[var(--border-primary)] pt-4">
          {document.sources.map((source, index) => (
            source.url ? (
              <a
                key={`${document.id}-source-${index}`}
                className="text-xs font-medium text-[var(--text-accent)] underline-offset-4 hover:underline"
                href={source.url}
              >
                {source.label ?? source.citation ?? source.url}
              </a>
            ) : (
              <Text key={`${document.id}-source-${index}`} variant="body-xs" color="faint">
                {source.label ?? source.citation}
              </Text>
            )
          ))}
        </footer>
      ) : null}
    </article>
  );
}

export function PublicDocumentSite() {
  const documentsRaw = useBitfieldData('public-documents');
  const configRaw = useBitfieldData('public-site-config');
  const publicationViewRaw = useBitfieldData('public-document-publication-view');
  const model = React.useMemo(
    () => readPublicDocumentSiteModel(documentsRaw, configRaw, publicationViewRaw),
    [configRaw, documentsRaw, publicationViewRaw],
  );
  const name = typeof model.config?.entity?.name === 'string' ? model.config.entity.name : 'Published documents';

  return (
    <ScrollableSurface>
      <main className="min-h-full bg-[var(--surface-secondary)]">
        <Container layout="vertical" gap="lg" className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
          <header className="space-y-2">
            <Text variant="caption" color="faint">{name}</Text>
            <Text variant="heading-2xl" weight="semibold">Documents</Text>
          </header>
          {model.documents.length ? (
            <div className="grid gap-4">
              {model.documents.map((document) => <DocumentPreview key={document.id} document={document} />)}
            </div>
          ) : (
            <Text variant="body" color="secondary" className="rounded-lg border border-[var(--border-primary)] bg-[var(--surface-primary)] p-5">
              No published documents yet.
            </Text>
          )}
        </Container>
      </main>
    </ScrollableSurface>
  );
}
