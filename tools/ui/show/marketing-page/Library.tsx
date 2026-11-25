// tools/ui/show/marketing-page/Library.tsx
//
// PURPOSE
//   A library as a landing page shows it: a row of tabs (one per shelf), under it a browser frame with the chosen entry large
//   (a looping video or a picture with its title and length over it) and a list of the shelf's entries beside it. A page row
//   names it as `ui/show/marketing-page/Library.tsx#Library`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: no fetch, no window and no state while it renders. Which shelf and which entry are chosen is the host's:
//      `selectedTab` and `selectedId` in, `onSelectTab(id)` and `onSelectEntry(id)` out. With none given, the first shelf and
//      its first entry are drawn.
//   2. An entry shows only on its own shelf; a shelf with no entries draws its tab and an empty browser, never an error.
//   3. Pictures and videos are the shared MediaFrame's; tabs and entries are the shared Button; the look is the screen look's
//      (ComparisonLibrarySection.module.css). No raw HTML, no inline styling.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import { Button } from '../button/Button.tsx';
import { MediaFrame } from '../media-frame/MediaFrame.tsx';
import { Text } from '../text/Text.tsx';
import styles from '../../../screen-look/show/adaptive-program-landing/ComparisonLibrarySection.module.css';

export type LibraryTab = { id: string; label: string };
export type LibraryEntry = {
  id: string;
  tab: string;
  title: string;
  /** What is said under the title in the list, such as the shelf and the length. */
  meta?: string;
  /** The length shown over the large entry. */
  duration?: string;
  /** A picture of the entry. */
  still?: string;
  /** A video of the entry; the large preview plays it. */
  video?: string;
};

export type LibraryProps = {
  intro?: string;
  tabs: readonly LibraryTab[];
  entries: readonly LibraryEntry[];
  selectedTab?: string;
  selectedId?: string;
  /** The words over the browser frame, and its count of entries ({count} is filled in). */
  browserTitle?: string;
  countLabel?: string;
  tabsLabel?: string;
  listLabel?: string;
  onSelectTab?: (id: string) => void;
  onSelectEntry?: (id: string) => void;
};

export function View({ intro, tabs, entries, selectedTab, selectedId, browserTitle, countLabel = '{count}', tabsLabel, listLabel, onSelectTab, onSelectEntry }: LibraryProps) {
  const tab = tabs.find(item => item.id === selectedTab) ?? tabs[0];
  const shelf = tab ? entries.filter(entry => entry.tab === tab.id) : [];
  const chosen = shelf.find(entry => entry.id === selectedId) ?? shelf[0];
  return (
    <Text as="section" className={styles.libraryBlock} data-library>
      {intro ? <Text as="div" className={styles.libraryIntro}><Text as="h3">{intro}</Text></Text> : null}
      <Text as="div" role="group" aria-label={tabsLabel} className={styles.librarySelector}>
        {tabs.map(item => (
          <Button key={item.id} variant="ghost" className={styles.librarySelectorButton} aria-pressed={item.id === tab?.id} data-active={item.id === tab?.id ? 'true' : 'false'} data-library-selector={item.id} onClick={() => onSelectTab?.(item.id)}>
            {item.label}
          </Button>
        ))}
      </Text>
      <Text as="div" className={styles.browser} data-library-browser>
        <Text as="div" className={styles.browserToolbar}>
          <Text as="span" aria-hidden="true" className={styles.trafficLights}>
            <Text as="span" />
            <Text as="span" />
            <Text as="span" />
          </Text>
          {browserTitle ? <Text as="span" className={styles.toolbarTitle}>{browserTitle}</Text> : null}
          <Text as="span" className={styles.toolbarCount}>{countLabel.replace('{count}', String(shelf.length))}</Text>
        </Text>
        <Text as="div" className={styles.browserBody}>
          <Text as="div" className={styles.mainPreview} data-library-preview={chosen?.id}>
            {chosen?.video ? <MediaFrame url={chosen.video} mediaType="video/mp4" label={chosen.title} className={styles.previewMedia} fill autoPlay muted loop playsInline poster={chosen.still} />
              : chosen?.still ? <MediaFrame url={chosen.still} mediaType="image/jpeg" label={chosen.title} className={styles.previewMedia} fill /> : null}
            {chosen ? (
              <Text as="div" className={styles.previewCopy}>
                <Text as="strong">{chosen.title}</Text>
                {chosen.duration ? <Text as="small">{chosen.duration}</Text> : null}
              </Text>
            ) : null}
          </Text>
          <Text as="div" aria-label={listLabel} className={styles.libraryList}>
            {shelf.map(entry => (
              <Button key={entry.id} variant="ghost" className={styles.libraryItem} aria-pressed={entry.id === chosen?.id} data-active={entry.id === chosen?.id ? 'true' : 'false'} data-library-entry={entry.id} onClick={() => onSelectEntry?.(entry.id)}>
                {entry.still ? <MediaFrame url={entry.still} mediaType="image/jpeg" label="" className={styles.itemThumb} fill /> : null}
                <Text as="span" className={styles.itemCopy}>
                  <Text as="strong">{entry.title}</Text>
                  {entry.meta ? <Text as="span">{entry.meta}</Text> : null}
                </Text>
              </Button>
            ))}
          </Text>
        </Text>
      </Text>
    </Text>
  );
}

export { View as Library };
