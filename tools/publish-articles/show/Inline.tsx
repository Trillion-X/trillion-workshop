// tools/publish-articles/show/Inline.tsx
//
// A paragraph's words with bold and links. A link to #source-N is drawn as a footnote number. A link goes only to a web
// address, a path on the site, a page anchor or a mail address; any other address is drawn as its words, not as a link.
import React from 'react';
import { Button } from '../../ui/show/button/Button.tsx';
import { Text } from '../../ui/show/marketing-page/MarketingPagePrimitives.tsx';

const SAFE_ADDRESS = /^(https?:\/\/|\/(?!\/)|#|mailto:)/i;

export function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean);
  return (
    <>
      {parts.map((part, index) => {
        const bold = /^\*\*([^*]+)\*\*$/.exec(part);
        if (bold) return <Text as="strong" key={index}>{bold[1]}</Text>;
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
        if (!link) return <React.Fragment key={index}>{part}</React.Fragment>;
        const [, label, href] = link;
        if (!SAFE_ADDRESS.test(href)) return <React.Fragment key={index}>{label}</React.Fragment>;
        const note = /^#source-(\d+)$/.exec(href);
        if (note) return <Text as="sup" key={index}><Button href={href} variant="plain" size="xs">{note[1]}</Button></Text>;
        return <Button key={index} href={href} variant="plain" size="xs" wrap>{label}</Button>;
      })}
    </>
  );
}
