// Draw the image a story or the stories feed shows when it is shared (Open Graph, 1200x630), from the same shared
// page writer and words the pages use, photographed by a headless browser into assets/stories-share.png.
//   node scripts/make-stories-share-image.mjs
import { writeFileSync } from 'node:fs';
import { launchChromium } from '../../headless-browser/launch.mjs';
import { pageShellHtml } from '../../organize-my-files/parts/ui/show/server-rendered-page/page-sections-html.mjs';
import { PAGE_LOOK } from '../src/page-look.mjs';
import settings from '../src/story-settings.json' with { type: 'json' };

const { words } = settings;
const html = pageShellHtml({
  language: 'en',
  look: PAGE_LOOK,
  title: words.feed_title,
  layout: 'browse',
  sections: [{ emphasis: 'invite', heading: words.feed_heading, body: words.feed_description }],
});
const browser = await launchChromium();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  // The card fills the frame: the section's own look, sized to the share image.
  await page.addStyleTag({ content: '.page-layout{max-width:none;padding:0}.page-section--invite{margin:0!important;border-radius:0;min-height:630px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;padding:0 96px!important}.page-section--invite .page-heading{font-size:76px;line-height:1.05;max-width:15ch;margin-bottom:28px}.page-section--invite .page-body{font-size:26px;max-width:34em}' });
  const png = await page.locator('.page-section--invite').screenshot();
  writeFileSync(new URL('../assets/stories-share.png', import.meta.url), png);
  process.stdout.write(`assets/stories-share.png ${png.length} bytes\n`);
} finally {
  await browser.close();
}
