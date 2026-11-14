'use client';

import React, { useState } from 'react';
import { LANDING_SOLID_HIGHLIGHT_COLOR } from '@/packages/ui/show/marketing-page/MarketingPagePrimitives';
import styles from '@/packages/screen-look/show/adaptive-program-landing/ComparisonLibrarySection.module.css';
import { useProgramLandingData } from './ProgramLandingData';
import { ProgramComparisonShowcase } from './ProgramComparisonShowcase';

const VISIBLE_MODULE_COUNT = 4;

function largeYoutubePreview(src: string): string {
  return src.replace(/\/hqdefault\.jpg(?=\?|$)/, '/maxresdefault.jpg');
}

export function ComparisonLibrarySection({ showComparison = true }: { showComparison?: boolean }) {
  const data = useProgramLandingData();
  const copy = data.comparisonLibrary;
  const libraryNames = data.libraryNames;
  const libraryPreviews = data.libraryPreviews;
  const [selectedLibrary, setSelectedLibrary] = useState<string>(libraryNames[0]);
  const libraryEntries = libraryPreviews.filter((entry) => entry.library === selectedLibrary);
  const [selectedId, setSelectedId] = useState(libraryEntries[0].id);
  const selected = libraryEntries.find((entry) => entry.id === selectedId) ?? libraryEntries[0];

  return (
    <div className={styles.root} data-testid="program-comparison-library">
      {showComparison ? <ProgramComparisonShowcase instanceId="library" /> : null}

      <div className={styles.libraryBlock}>
        <div className={styles.libraryIntro}>
          <h3>{copy.intro.map((segment: { text: string; highlighted?: boolean }, index: number) => segment.highlighted ? <span key={index} style={{ color: LANDING_SOLID_HIGHLIGHT_COLOR }}>{segment.text}</span> : <React.Fragment key={index}>{segment.text}</React.Fragment>)}</h3>
        </div>

        <div aria-label={copy.selectorAriaLabel} className={styles.librarySelector} role="group">
          {libraryNames.map((library) => (
            <button
              aria-pressed={selectedLibrary === library}
              className={styles.librarySelectorButton}
              data-active={selectedLibrary === library ? 'true' : 'false'}
              data-library-selector={library}
              key={library}
              onClick={() => {
                setSelectedLibrary(library);
                const firstEntry = libraryPreviews.find((entry) => entry.library === library);
                if (firstEntry) setSelectedId(firstEntry.id);
              }}
              type="button"
            >
              {library}
            </button>
          ))}
        </div>

        <div className={styles.browser} data-testid="program-library-browser">
          <div className={styles.browserToolbar}>
            <span aria-hidden="true" className={styles.trafficLights}><span /><span /><span /></span>
            <span className={styles.toolbarTitle}>{copy.browserTitle}</span>
            <span className={styles.toolbarCount}>{copy.entryCountTemplate.replace('{count}', String(libraryEntries.length))}</span>
          </div>
          <div className={styles.browserBody}>
            <div className={styles.mainPreview} data-testid="program-library-preview" data-preview-id={selected.id}>
              {selected.preview.kind === 'video' ? (
                <video
                  key={selected.id}
                  aria-label={copy.itemAriaTemplate.replace('{title}', selected.title)}
                  autoPlay
                  className={styles.previewMedia}
                  data-testid="program-library-preview-video"
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  src={selected.preview.src}
                />
              ) : (
                // Real YouTube thumbnail staged from the media record's embed ID.
                <img
                  key={selected.id}
                  className={styles.previewMedia}
                  src={largeYoutubePreview(selected.preview.src)}
                  onError={(event) => {
                    if (event.currentTarget.src !== selected.preview.src) event.currentTarget.src = selected.preview.src;
                  }}
                  alt={copy.itemAriaTemplate.replace('{title}', selected.title)}
                />
              )}
              <div className={styles.previewShade} />
              <div className={styles.previewCopy}>
                <strong>{selected.title}</strong>
                <small>{selected.duration}</small>
              </div>
            </div>

            <div aria-label={copy.listAriaLabel} className={styles.libraryList}>
              {libraryEntries.map((entry, index) => (
                <button
                  aria-pressed={entry.id === selected.id}
                  aria-hidden={index >= VISIBLE_MODULE_COUNT ? true : undefined}
                  className={styles.libraryItem}
                  data-active={entry.id === selected.id ? 'true' : 'false'}
                  data-obscured={index >= VISIBLE_MODULE_COUNT ? 'true' : 'false'}
                  data-library-entry={entry.id}
                  data-source-record={entry.sourceRecordId}
                  disabled={index >= VISIBLE_MODULE_COUNT}
                  key={entry.id}
                  onClick={() => setSelectedId(entry.id)}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className={styles.itemThumb}
                    style={{ backgroundImage: entry.preview.kind === 'image' ? `url(${entry.preview.src})` : 'linear-gradient(135deg, #17382d, #649079)' }}
                  />
                  <span className={styles.itemCopy}>
                    <strong>{entry.title}</strong>
                    <span>{entry.library} · {entry.duration}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
