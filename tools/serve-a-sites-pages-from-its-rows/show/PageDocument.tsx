// tools/serve-a-sites-pages-from-its-rows/show/PageDocument.tsx
//
// PURPOSE
//   The whole document of one site page, drawn on the server around the page's drawn tree: its language, title, canonical
//   address, the parts' stylesheet, the site's look as CSS variables, the mount (the shared Container) holding the server's
//   markup of the tree, the tree itself as inert JSON, and the one generic mount script that draws the same tree in the browser.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Pure: everything comes in as props; nothing here knows any site.
//   2. The look and the tree arrive already made safe by render.ts (a look value can never end its declaration; the tree's
//      JSON can never close its script element), so they are written as they are.
//   3. The mount is the shared Container (tools/ui/show/container), flowing as a block, never a raw element.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import React from 'react';
import type { ReactNode } from 'react';
import { Container } from '../../ui/show/container/container.tsx';

export interface PageDocumentProps {
  lang: string;
  title: string;
  canonical: string;
  sheet: string;
  look: string;
  script: string;
  /** The drawn tree as JSON, already safe inside a script element. */
  tree: string;
  /** The id of the mount and of the tree's script: the mount script reads both. */
  mount: string;
  children?: ReactNode;
}

export function PageDocument({ lang, title, canonical, sheet, look, script, tree, mount, children }: PageDocumentProps) {
  return (
    <html lang={lang}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        {canonical ? <link rel="canonical" href={canonical} /> : null}
        <link rel="stylesheet" href={sheet} />
        {look ? <style dangerouslySetInnerHTML={{ __html: look }} /> : null}
      </head>
      <body>
        <Container layout="flow" id={mount}>{children}</Container>
        <script type="application/json" id={`${mount}-tree`} dangerouslySetInnerHTML={{ __html: tree }} />
        {script ? <script type="module" src={script} /> : null}
      </body>
    </html>
  );
}
