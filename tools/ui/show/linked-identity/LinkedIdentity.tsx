// packages/ui/show/linked-identity/LinkedIdentity.tsx
//
// PURPOSE
//   One small mark that names something outside the app (a platform, an
//   account, a person) and opens it. The mark is an image when one is known,
//   the provider's registered logo when the thing is a provider, and the
//   name's initials otherwise (the shared person mark, show/display-mark). Hover or focus shows the shared Tooltip with
//   the name and, when the thing can be opened, an up-right arrow. Pressing it
//   opens the address in a placeable web-frame pane beside the work, never a
//   browser window.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No provider is named here. Logos and profile addresses come from the
//      provider-icon registry DATA (`profile_link`), so a new provider is a row.
//   2. Only plain https/http addresses without credentials are ever opened.
//   3. An identity with nothing to open is a labelled image, not a button.
//   4. Appearance (size, hover lift, hover colour) belongs to screen-look
//      through the `linked-identity*` classes.
import React from 'react';
import {ArrowUpRight} from 'lucide-react';
import {Tooltip} from '../tooltip';
import {ProviderMark} from '../provider-mark/ProviderMark';
import {normalizeProviderSlug,providerProfileUrl,type ProviderIconRegistryRow} from '../provider-mark/provider-icon-registry';
import {emitPlaceableSurfaceIntent} from '../placeable-surface-intent/placeable-surface-intent';
import {Avatar,AvatarFallback,AvatarImage} from '../coss/ui/avatar';
import {DisplayMark} from '../display-mark';
import {Button} from '../coss/ui/button';

export type LinkedIdentityOptions={
  /** What the mark names; shown in the tooltip and read by assistive tech. */
  label:string;
  /** Second part of the tooltip, for example the platform. */
  detail?:string;
  /** `provider` draws the provider's logo; `avatar` draws the image or initials. */
  mark?:'provider'|'avatar';
  providerSlug?:string;
  imageUrl?:string;
  /** Explicit address. Wins over a handle resolved through the registry. */
  href?:string;
  /** Public handle resolved to an address by the provider's `profile_link` row. */
  handle?:string;
  registry?:readonly ProviderIconRegistryRow[];
};

export function safeLinkedIdentityUrl(value:unknown):string{
  if(typeof value!=='string'||!value||value.length>2048)return '';
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}
}


/** Open an address in a placeable pane beside the current work. */
export function openLinkedIdentity(title:string,href:string){
  const safe=safeLinkedIdentityUrl(href);
  if(!safe)return false;
  emitPlaceableSurfaceIntent({
    id:'web-frame.project-preview',
    title,
    materialTarget:'component:web-frame-project-preview-surface',
    packageEntry:{packageName:'web-frame',entryName:'web-frame-project-preview-surface'},
    surfaceInput:{source_value:safe,isConnected:true},
    // Beside the work, in its own container, so the schedule stays in view.
    placement:'right',
  });
  return true;
}

export function LinkedIdentity({label,detail,mark='avatar',providerSlug,imageUrl,href,handle,registry=[]}:LinkedIdentityOptions){
  const name=label.trim()||detail?.trim()||'Unnamed';
  const slug=normalizeProviderSlug(providerSlug);
  const address=safeLinkedIdentityUrl(href)||providerProfileUrl(registry,slug,handle);
  const image=safeLinkedIdentityUrl(imageUrl);
  const tooltip=[name,detail?.trim()].filter(Boolean).join(' · ');
  // A person is drawn by the shared person mark (their picture, or their initials); a provider by its own logo.
  const face=(extra:string)=>mark==='provider'
    ? <Avatar className={`linked-identity-face${extra}`} data-mark={mark}>
        {image?<AvatarImage src={image} alt=""/>:null}
        <AvatarFallback className="linked-identity-fallback"><ProviderMark providerSlug={slug||name} providerName={name} registry={registry} size="xs" decorative/></AvatarFallback>
      </Avatar>
    : <span className={`linked-identity-face${extra}`} data-mark={mark}><DisplayMark key={image??''} spec={{name,...(image?{image}:{})}} size="sm"/></span>;
  const trigger=address
    ? <Button type="button" variant="ghost" size="icon-xs" className="linked-identity" data-mark={mark} data-openable="true"
        aria-label={`Open ${tooltip}`} onClick={event=>{event.stopPropagation();openLinkedIdentity(name,address);}}>
        {face('')}
      </Button>
    : <span className="linked-identity" data-mark={mark} role="img" tabIndex={0} aria-label={tooltip}>{face('')}</span>;
  return <Tooltip label={tooltip} side="top" delayDuration={350}
    trailing={address?<ArrowUpRight className="linked-identity-open-cue" aria-hidden="true"/>:undefined}>{trigger}</Tooltip>;
}
