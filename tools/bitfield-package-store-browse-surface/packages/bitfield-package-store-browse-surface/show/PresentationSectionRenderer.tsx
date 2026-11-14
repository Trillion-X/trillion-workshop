import React from 'react';
import { Badge } from '@/packages/ui/show/badge';
import { Button } from '@/packages/ui/show/button';
import { Card } from '@/packages/ui/show/card';
import { Container } from '@/packages/ui/show/container';
import { MediaCarousel } from '@/packages/ui/show/media-carousel';
import { MetricRow, type MetricCell } from '@/packages/ui/show/metric-row';
import { Text } from '@/packages/ui/show/text';
import type { PresentationSection, MediaItem } from '../read-data/read-catalog-view';

/**
 * Generic section renderer for presentation sections.
 *
 * Takes DATA-driven presentation_section rows and renders them through
 * a dispatcher (NOT a closed switch). Each section_kind maps to a handler
 * component. Zero domain vocabulary; all labels come from DATA.
 *
 * This is the Generic Gate test: adding a new section = ONE DATA row, ZERO code change
 * (section-kind dispatcher + handler registration are the only extension points).
 *
 * EXTENSIBILITY: To add a new section_kind, follow this pattern:
 * 1. Emit the section_kind in read-catalog-view.ts (add to presentation_sections array)
 * 2. Create a handler function below (e.g., NewSectionHandler)
 * 3. Register it in sectionHandlers (e.g., new_section_kind: NewSectionHandler)
 * 4. Zero other files change; no closed enums, no "if-kind-===" branching
 */
export function PresentationSectionRenderer({
  sections,
}: {
  sections: PresentationSection[];
}) {
  // Section-kind dispatcher registry. Each entry maps section_kind -> handler component.
  // Extensible via DATA: adding a new section_kind DATA row requires ONE handler registration here.
  const sectionHandlers: Record<string, React.ComponentType<{ section: PresentationSection }>> = {
    media_carousel: MediaCarouselSection,
    stat_strip: StatStripSection,
    description: DescriptionSection,
    spec_rows: SpecRowsSection,
    review_summary: ReviewSummarySection,
    capability_badges: CapabilityBadgesSection,
  };

  return (
    <>
      {sections.map((section, index) => {
        const Handler = sectionHandlers[section.section_kind];
        if (!Handler) {
          return null;
        }
        return <Handler key={index} section={section} />;
      })}
    </>
  );
}

// ============================================================================
// Section Handlers — Each renders one section_kind
// ============================================================================

function MediaCarouselSection({ section }: { section: PresentationSection }) {
  const items = Array.isArray(section.items) ? (section.items as MediaItem[]) : [];
  if (items.length === 0) return null;

  return (
    <Card variant="outlined">
      <MediaCarousel items={items} />
    </Card>
  );
}

function DescriptionSection({ section }: { section: PresentationSection }) {
  const body = typeof section.body === 'string' ? section.body : '';
  if (!body) return null;

  return (
    <Text variant="body-lg" color="muted" leading="relaxed">
      {body}
    </Text>
  );
}

function SpecRowsSection({ section }: { section: PresentationSection }) {
  const title = typeof section.title === 'string' ? section.title : '';
  const rows = Array.isArray(section.rows)
    ? (section.rows as Array<{ label: string; value: string }>)
    : [];

  if (rows.length === 0) return null;

  return (
    <>
      {title && <Text variant="heading-lg">{title}</Text>}
      {rows.map((row, index) => (
        <Card key={index} variant="outlined">
          {row.label && <Text variant="body-xs" color="muted">{row.label}</Text>}
          <Text variant="body-sm">{row.value}</Text>
        </Card>
      ))}
    </>
  );
}

function StatStripSection({ section }: { section: PresentationSection }) {
  const cells = Array.isArray(section.cells)
    ? (section.cells as Array<{ label: string; value: string; caption: string }>)
    : [];

  if (cells.length === 0) return null;

  const metricCells: MetricCell[] = cells.map((cell) => ({
    label: cell.label.toUpperCase(),
    value: cell.value,
    mono: false,
  }));

  return (
    <Card variant="outlined">
      <Container layout="vertical" padding="md" gap="md">
        <MetricRow cells={metricCells} align="between" />
        <Container layout="vertical" gap="xs">
          {cells.map((cell, index) => (
            <Text key={index} variant="body-xs" color="muted">
              {cell.caption}
            </Text>
          ))}
        </Container>
      </Container>
    </Card>
  );
}

function ReviewSummarySection({ section }: { section: PresentationSection }) {
  const average = typeof section.average === 'number' ? section.average : null;
  const count = typeof section.count === 'number' ? section.count : 0;
  const distribution = Array.isArray(section.distribution)
    ? (section.distribution as Array<{ value: number; count: number }>)
    : [];
  const reviews = Array.isArray(section.reviews)
    ? (section.reviews as Array<{ author: string; rating: number; date: string; text: string }>)
    : [];

  if (average === null && count === 0 && distribution.length === 0 && reviews.length === 0) {
    return null;
  }

  const starRating = average !== null ? Math.round(average * 10) / 10 : 0;
  const formatCount = (n: number) => (n > 999 ? `${Math.floor(n / 1000)}.${Math.floor((n % 1000) / 100)}K` : String(n));

  const maxDistCount = distribution.length > 0 ? Math.max(...distribution.map((d) => d.count)) : 1;
  const distributionCells: MetricCell[] = [5, 4, 3, 2, 1].map((starValue) => {
    const dist = distribution.find((d) => d.value === starValue);
    const distCount = dist?.count ?? 0;
    const percentage = maxDistCount > 0 ? (distCount / maxDistCount) * 100 : 0;
    return {
      label: `${starValue}★`,
      value: `${'█'.repeat(Math.floor(percentage / 10))} ${distCount}`,
      mono: true,
    };
  });

  return (
    <Card variant="outlined">
      <Container layout="vertical" padding="lg" gap="lg">
        <Container layout="horizontal" gap="lg" alignItems="start">
          <Container layout="vertical" gap="xs">
            <Text variant="display-lg">
              {average !== null ? starRating.toFixed(1) : 'No ratings'}
            </Text>
            {average !== null && (
              <Text variant="body-sm" color="muted">
                out of 5
              </Text>
            )}
          </Container>
          {average !== null && (
            <Container layout="vertical" gap="xs">
              <Container layout="horizontal" gap="xs">
                {[1, 2, 3, 4, 5].map((i) => (
                  <Text key={i} variant="body-sm">
                    {i <= Math.round(average) ? '★' : '☆'}
                  </Text>
                ))}
              </Container>
              <Text variant="body-sm" color="muted">
                {formatCount(count)} Ratings
              </Text>
            </Container>
          )}
        </Container>

        {distribution.length > 0 && (
          <Container layout="vertical" gap="sm">
            <MetricRow cells={distributionCells} align="start" />
          </Container>
        )}

        {reviews.length > 0 && (
          <Container layout="vertical" gap="md" border="top">
            {reviews.slice(0, 3).map((review, index) => (
              <Container key={index} layout="vertical" gap="xs">
                <Container layout="horizontal" gap="md" justifyContent="between" alignItems="start">
                  <Container layout="vertical" gap="xs">
                    <Text variant="body-sm">
                      {review.author}
                    </Text>
                    <Container layout="horizontal" gap="xs">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <Text key={i} variant="body-xs">
                          {i <= (review.rating || 0) ? '★' : '☆'}
                        </Text>
                      ))}
                    </Container>
                  </Container>
                  <Text variant="body-xs" color="muted">
                    {review.date}
                  </Text>
                </Container>
                <Text variant="body-sm" color="muted">
                  {review.text}
                </Text>
              </Container>
            ))}
            {reviews.length > 3 && (
              <Button variant="ghost" size="sm">
                See all {reviews.length} reviews
              </Button>
            )}
          </Container>
        )}
      </Container>
    </Card>
  );
}

function CapabilityBadgesSection({ section }: { section: PresentationSection }) {
  const badges = Array.isArray(section.badges) ? (section.badges as string[]) : [];
  if (badges.length === 0) return null;

  return (
    <>
      {badges.map((badge) => (
        <Badge key={badge} variant="neutral" size="lg">
          {badge}
        </Badge>
      ))}
    </>
  );
}
