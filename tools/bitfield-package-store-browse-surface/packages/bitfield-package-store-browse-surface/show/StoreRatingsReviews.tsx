import React from 'react';
import { Container } from '@/packages/ui/show/container';
import { Text } from '@/packages/ui/show/text';
import { Card } from '@/packages/ui/show/card';
import { Badge } from '@/packages/ui/show/badge';
import { Divider } from '@/packages/ui/show/divider';
import { ProgressBar } from '@/packages/ui/show/progress-bar';

// Mac App Store style Ratings and Reviews block, composed only from ui/ primitives
// (L065). Grounded on the App Store / Best Buy / Faire review anatomy captured from
// Mobbin: a big average score, a 5-to-1 star distribution of bars, a review count,
// an optional would-recommend line, and review cards. All data is real caller DATA;
// when there are zero reviews it renders an honest empty state, never fake reviews
// (L117).

export interface StoreReviewItem {
  readonly id: string;
  readonly author: string;
  readonly score: number;
  readonly date: string;
  readonly title?: string;
  readonly body: string;
  readonly verified?: boolean;
}

export interface StoreReviewDistributionRow {
  readonly stars: number;
  readonly percent: number;
}

export interface StoreRatingsReviewsProps {
  readonly averageScore: number;
  readonly totalCount: number;
  readonly distribution: readonly StoreReviewDistributionRow[];
  readonly recommendPercent?: number;
  readonly reviews: readonly StoreReviewItem[];
}

function starRow(score: number, max = 5): string {
  const full = Math.round(score);
  return '★★★★★☆☆☆☆☆'.slice(5 - full, 10 - full).slice(0, max);
}

function ReviewCard({ review }: { review: StoreReviewItem }) {
  return (
    <Card variant="nested" padding="md" layout="stack">
      <Container layout="vertical" gap="xs">
        <Container layout="horizontal" gap="sm">
          <Text variant="body" weight="medium">{review.author}</Text>
          {review.verified ? <Badge variant="secondary" size="sm">Verified</Badge> : null}
        </Container>
        <Container layout="horizontal" gap="sm">
          <Text variant="body-sm" color="warning">{starRow(review.score)}</Text>
          <Text variant="body-sm" color="muted">{review.date}</Text>
        </Container>
        {review.title ? <Text variant="body" weight="medium">{review.title}</Text> : null}
        <Text variant="body-sm" color="muted" leading="relaxed">{review.body}</Text>
      </Container>
    </Card>
  );
}

export function StoreRatingsReviews({
  averageScore,
  totalCount,
  distribution,
  recommendPercent,
  reviews,
}: StoreRatingsReviewsProps) {
  if (totalCount <= 0) {
    return (
      <Container layout="vertical" gap="md">
        <Text variant="heading">Ratings and Reviews</Text>
        <Card variant="nested" padding="lg" layout="stack">
          <Container layout="vertical" gap="xs">
            <Text variant="body-lg" weight="medium">No reviews yet</Text>
            <Text variant="body-sm" color="muted">Be the first to install this package and share how it worked for your product.</Text>
          </Container>
        </Card>
      </Container>
    );
  }

  return (
    <Container layout="vertical" gap="md">
      <Text variant="heading">Ratings and Reviews</Text>
      <Container layout="horizontal" gap="lg">
        <Container layout="vertical" gap="xs">
          <Text variant="heading-xl">{averageScore.toFixed(1)}</Text>
          <Text variant="body-sm" color="warning">{starRow(averageScore)}</Text>
          <Text variant="caption" color="muted">{totalCount} reviews</Text>
        </Container>
        <Container layout="vertical" gap="xs">
          {distribution.map((row) => (
            <Container key={row.stars} layout="horizontal" gap="sm">
              <Text variant="caption" color="muted">{row.stars}★</Text>
              <Container layout="vertical" width="full">
                <ProgressBar percentage={row.percent} color="var(--color-warning)" />
              </Container>
              <Text variant="caption" color="muted">{row.percent}%</Text>
            </Container>
          ))}
        </Container>
      </Container>
      {typeof recommendPercent === 'number' ? (
        <Text variant="body-sm" color="muted">{recommendPercent}% would recommend this package</Text>
      ) : null}
      <Divider />
      <Container layout="vertical" gap="sm">
        {reviews.map((review) => (
          <ReviewCard key={review.id} review={review} />
        ))}
      </Container>
    </Container>
  );
}
