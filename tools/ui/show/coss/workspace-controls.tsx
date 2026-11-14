import {disposers,mountSharedContent} from './shared-content';
import {releaseNode} from '../one-owner-per-node';
import {claimFloatingSurface,releaseFloatingSurface,FloatingPanelFrame} from './floating-surface';
import {enhanceSelect,enhanceCheckbox} from './native-controls';
export {enhanceSelect,enhanceCheckbox};
export {claimFloatingSurface,releaseFloatingSurface,FloatingPanelFrame};
export type {FloatingSurface,FloatingPanelRefs} from './floating-surface';
import {EmptyState,NOTHING_HERE_YET,type EmptyStateOptions} from '../empty-state';
import {ScreenState,type LoadingLayout,type ScreenStateValue} from '../screen-state/ScreenState';
import {beginMediaDrag} from '../selection/media-drag-session.mjs';
import {mountMarqueeSelection} from '../selection/marquee-selection.mjs';
import React from 'react';
import {lazyPart} from '../load-later/later';
import {MoreHorizontal,ArrowUp,Square,ChevronRight,FileVideo,ImageOff,Eye,Pencil} from 'lucide-react';
import {ProviderMark} from '../provider-mark/ProviderMark';
import {providerIconRegistry} from '../provider-mark/shipped-provider-icons';
import {normalizeProviderSlug,type ProviderIconRegistryRow} from '../provider-mark/provider-icon-registry';
import {Empty,EmptyHeader,EmptyTitle,EmptyContent} from '../shadcn/empty';
import {ActivityLabel} from '../aicss/ActivityLabel';
import {Tooltip} from '../tooltip';
import {LinkedIdentity,type LinkedIdentityOptions} from '../linked-identity';
import {RecordKindMark,RecordStateMark,recordKindLabel,recordKindValues,recordStateValues,type RecordKindOptions,type RecordStateOptions} from '../record-kind';
import {ConnectionSection,type ConnectionSectionOptions} from '../connection-list';
import {Button} from './ui/button';
import {Badge} from './ui/badge';
import {ActionMenu,checkActionMenuItems,type ActionMenuItem,type ActionShortcut} from '../action-menu';
import {Select,SelectTrigger,SelectValue,SelectPopup,SelectItem} from './ui/select';
import {Card,CardPanel,CardFooter} from './ui/card';
import {DisplayMark} from '../display-mark';
import {Checkbox} from './ui/checkbox';
import {Input} from './ui/input';
import {Textarea} from './ui/textarea';
import {Table,TableBody,TableCell,TableHead,TableHeader,TableRow} from './ui/table';
import {RotatingCarousel} from '../cult/rotating-carousel';
import {ActionPrompt,type ActionPromptOptions} from './action-prompt';
import {CalendarGrid,type CalendarGridCell,type CalendarGridDensity} from '../calendar-grid';
import {HourGrid,type HourGridLane} from '../hour-grid';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
export {mountProjectTree,mountProjectTreePicker,ProjectTree} from './project-tree';
export type {ProjectTreeCreateKind,ProjectTreeItem,ProjectTreeOptions,ProjectTreeWords} from './project-tree';

type SelectionGesture={range:boolean;toggle:boolean};
type RecordTableItem={id:string;title:string;cells:Record<string,{text:string;detail?:string}>;actions?:Array<{id:string;label:string}>};
export function mountRecordTable(node:HTMLElement,options:{label:string;columns:Array<{id:string;label:string;primary?:boolean}>;items:RecordTableItem[];selected?:string[];selectionMode?:boolean;empty?:EmptyStateOptions;onSelect?:(id:string,checked:boolean)=>void;onSelectionGesture?:(id:string,gesture:SelectionGesture)=>void;onOpen?:(id:string)=>void;onAction?:(id:string,action:string)=>void}){
  // A header row over nothing is a blank table, which tells the person less
  // than a sentence would. The columns are no use until there is something
  // under them.
  if(!options.items?.length)return mountSharedContent(node,<EmptyState {...(options.empty||{})}/>);
  const selected=new Set(options.selected||[]);
  const open=(event:React.MouseEvent,id:string)=>{if(options.onSelectionGesture&&(options.selectionMode||event.shiftKey||event.metaKey||event.ctrlKey)){event.preventDefault();options.onSelectionGesture(id,{range:event.shiftKey,toggle:event.metaKey||event.ctrlKey});return;}options.onOpen?.(id);};
  return mountSharedContent(node,<Table aria-label={options.label} className="coss-record-table"><TableHeader><TableRow>
    {options.onSelect&&<TableHead><span className="sr-only">Selection</span></TableHead>}
    {options.columns.map(column=><TableHead key={column.id}>{column.label}</TableHead>)}
    {options.onAction&&<TableHead>Actions</TableHead>}
  </TableRow></TableHeader><TableBody>{options.items.map(item=><TableRow key={item.id} data-record-id={item.id} data-selected={selected.has(item.id)||undefined}>
    {options.onSelect&&<TableCell><Checkbox aria-label={`Select ${item.title}`} checked={selected.has(item.id)} onCheckedChange={checked=>options.onSelect?.(item.id,checked===true)}/></TableCell>}
    {options.columns.map(column=><TableCell key={column.id}><div className="coss-record-table-value">
      {column.primary&&options.onOpen?<Button variant="ghost" onClick={event=>open(event,item.id)}>{item.cells[column.id]?.text||item.title}</Button>:item.cells[column.id]?.text}
      {item.cells[column.id]?.detail&&<div className="coss-record-table-detail">{item.cells[column.id].detail}</div>}
    </div></TableCell>)}
    {options.onAction&&<TableCell><div className="coss-record-table-actions" role="group" aria-label={`Actions for ${item.title}`}>{item.actions?.map(action=><Button key={action.id} variant="ghost" size="sm" onClick={()=>options.onAction?.(item.id,action.id)}>{action.label}</Button>)}</div></TableCell>}
  </TableRow>)}</TableBody></Table>);
}

const menuStates=new WeakMap<HTMLElement,{open:boolean}>();
export {mountSharedContent};
const mount=mountSharedContent;

export type AccountProfile={name?:string|null;email?:string|null;about?:string|null;avatarUrl?:string|null;emailVerified?:boolean;onSave?:(details:{name:string;email:string;about:string})=>Promise<void>};
function AccountProfileView(profile:AccountProfile){
  const name=profile.name?.trim()||'';
  const email=profile.email?.trim()||'';
  const about=profile.about?.trim()||'';
  const [draft,setDraft]=React.useState({name,email,about});
  const [status,setStatus]=React.useState('');
  const [saving,setSaving]=React.useState(false);
  React.useEffect(()=>{setDraft({name,email,about});setStatus('');},[name,email,about]);
  const save=async(event:React.FormEvent)=>{event.preventDefault();if(!profile.onSave)return;setSaving(true);setStatus('Saving…');try{await profile.onSave({name:draft.name.trim(),email:draft.email.trim(),about:draft.about.trim()});setStatus('Profile saved.');}catch(error){setStatus(errorWords(error, 'Could not save your profile.'));}finally{setSaving(false);}};
  return <section className="coss-account-profile" aria-label="Account">
    <header className="coss-account-header"><span aria-hidden="true"><DisplayMark key={profile.avatarUrl??''} spec={{name:name||'?',...(profile.avatarUrl?{image:profile.avatarUrl}:{})}} size="xl"/></span><div><h2>Account</h2><p>Your profile information</p></div></header>
    {profile.onSave?<form className="coss-account-fields" onSubmit={save}>
      <label className="coss-account-field"><span>Name</span><Input aria-label="Name" value={draft.name} placeholder="Add your name" maxLength={120} onChange={event=>{setDraft({...draft,name:event.currentTarget.value});setStatus('');}}/></label>
      {profile.emailVerified?<div className="coss-account-field"><span>Email</span><strong>{email}<small>Verified account email</small></strong></div>:<label className="coss-account-field"><span>Contact email<small>Not verified</small></span><Input aria-label="Contact email" type="email" value={draft.email} placeholder="Add a contact email" maxLength={254} onChange={event=>{setDraft({...draft,email:event.currentTarget.value});setStatus('');}}/></label>}
      <label className="coss-account-field"><span>About</span><Textarea aria-label="About" value={draft.about} placeholder="Add a few words about yourself" maxLength={2000} onChange={event=>{setDraft({...draft,about:event.currentTarget.value});setStatus('');}}/></label>
      <div className="coss-account-save"><Button type="submit" disabled={saving}>Save profile</Button><span role="status">{status}</span></div>
    </form>:<div className="coss-account-fields"><div className="coss-account-field"><span>Name</span><strong>{name||'No name available'}</strong></div><div className="coss-account-field"><span>Email</span><strong>{email||'No email available'}</strong></div><div className="coss-account-field"><span>About</span><strong>{about||'No profile description yet'}</strong></div></div>}
  </section>;
}
export function mountAccountProfile(node:HTMLElement,profile:AccountProfile={}){
  return mount(node,<AccountProfileView {...profile}/>);
}

export function mountActionPrompt(node:HTMLElement,options:ActionPromptOptions){
  let current={...options};
  const render=()=>mount(node,<ActionPrompt {...current}/>);
  render();
  return {update(next:Partial<ActionPromptOptions>){current={...current,...next};render();}};
}

/**
 * A compact, in-place publishing workspace.  It deliberately owns only the
 * reusable arrangement: selected destinations, edit/review stages and the
 * durable action rail.  The feature package supplies its real metadata fields
 * and publication actions as mounted shared-control nodes, so a product does
 * not recreate a second modal, a raw select, or platform-specific buttons.
 *
 * Layout anatomy is a behavioural port of Postiz's composer (channel picker,
 * focused editing surface, then a persistent scheduling action).  Its AGPL
 * source is not copied; every interactive control below is the pinned MIT
 * Coss Button, Badge, and Card source.
 */
export type PublicationWorkspaceDestination={id:string;label:string;detail?:string;selected?:boolean;ready?:boolean;publishable?:boolean;unavailable?:boolean;groupLabel?:string;providerSlug?:string;accountId?:string;serviceConnectionRef?:string;accountLabel?:string;formatLabel?:string;content?:React.ReactNode};
export type PublicationWorkspaceStage={id:string;label:string;detail?:string};
export type PublicationWorkspaceAction={id:string;label:string;disabled?:boolean;primary?:boolean};
export type PublicationWorkspaceOptions={
  label?:string;
  title:string;
  summary?:string;
  destinations:PublicationWorkspaceDestination[];
  /** Current provider-icon DATA from service-connections. If omitted, the
   * package's shipped provider registry supplies the same shared marks. */
  providerIconRegistry?:readonly ProviderIconRegistryRow[];
  stages:PublicationWorkspaceStage[];
  activeStage:string;
  content?:React.ReactNode;
  actions?:PublicationWorkspaceAction[];
  onDestination?:(id:string)=>void;
  onStage?:(id:string)=>void;
  onAction?:(id:string)=>void;
};

export type PublicationPostPreviewField={label:string;value:string};
export type PublicationPostPreviewOptions={
  destinationLabel:string;
  accountLabel?:string;
  providerSlug?:string;
  title:string;
  mediaUrl?:string;
  posterUrl?:string;
  fields:PublicationPostPreviewField[];
};

function safePublicationMediaUrl(value:string|undefined):string|undefined{
  if(!value)return;
  try{
    const url=new URL(value,window.location.href);
    return url.origin===window.location.origin||url.protocol==='https:'?url.href:undefined;
  }catch{return;}
}

// The player is fetched with the first post preview that shows a video, so the page never loads it first.
const FilePreview=lazyPart(()=>import('../file-preview/FilePreview'),module=>module.FilePreview);

/** Shows the saved media and exact destination writing without inventing a profile. */
export function mountPublicationPostPreview(node:HTMLElement,options:PublicationPostPreviewOptions){
  const mediaUrl=safePublicationMediaUrl(options.mediaUrl),posterUrl=safePublicationMediaUrl(options.posterUrl);
  return mount(node,<article className="coss-publication-post-preview" aria-label={`${options.destinationLabel} post preview`}>
    <header className="coss-publication-post-preview-header">
      <ProviderMark providerSlug={options.providerSlug||options.destinationLabel} providerName={options.destinationLabel} registry={providerIconRegistry} size="sm" decorative/>
      <div><strong>{options.accountLabel?.trim()||options.destinationLabel}</strong><small>{options.destinationLabel} · Preview</small></div>
    </header>
    {mediaUrl?<div className="coss-publication-post-preview-media"><React.Suspense fallback={null}><FilePreview url={mediaUrl} contentType="video/mp4" poster={posterUrl} label={`${options.title} video preview`} autoPlay={false}/></React.Suspense></div>:<div className="coss-publication-post-preview-unavailable" role="img" aria-label="Saved video preview unavailable"><FileVideo aria-hidden="true"/><span>Saved video preview unavailable</span></div>}
    <div className="coss-publication-post-preview-copy">
      <strong>{options.title}</strong>
      {options.fields.map((field,index)=><p key={`${field.label}-${index}`}><span>{field.label}</span>{field.value}</p>)}
    </div>
  </article>);
}

/** A platform, account or person mark that opens beside the work; see linked-identity. */
export function linkedIdentityContent(options:LinkedIdentityOptions){
  return <LinkedIdentity registry={providerIconRegistry} {...options}/>;
}
/** A settings section of connections to outside services; see connection-list. */
export function mountConnectionSection(node:HTMLElement,options:ConnectionSectionOptions){
  return mount(node,<ConnectionSection registry={providerIconRegistry} {...options}/>);
}
/** What kind of thing a record is; see record-kind. */
export function recordKindContent(options:RecordKindOptions){
  return <RecordKindMark {...options}/>;
}
export function mountRecordKind(node:HTMLElement,options:RecordKindOptions){
  return mount(node,recordKindContent(options));
}
export {recordKindLabel,recordKindValues,recordStateValues};
/** A record's state, worded for its kind; see record-kind. */
export function recordStateContent(options:RecordStateOptions){
  return <RecordStateMark {...options}/>;
}
/** Several marks in one cell, in order; identical marks draw once. */
export function linkedIdentitiesContent(list:readonly LinkedIdentityOptions[]){
  const seen=new Set<string>();
  const unique=list.filter(options=>{const key=JSON.stringify([options.mark,options.label,options.providerSlug]);if(seen.has(key))return false;seen.add(key);return true;});
  return <>{unique.map(options=><LinkedIdentity key={JSON.stringify([options.mark,options.label,options.providerSlug])} registry={providerIconRegistry} {...options}/>)}</>;
}
export function mountLinkedIdentity(node:HTMLElement,options:LinkedIdentityOptions){
  return mount(node,linkedIdentityContent(options));
}
type PublicationDestinationAccount={id:string;label:string;formats:PublicationWorkspaceDestination[]};
type PublicationDestinationPlatform={id:string;label:string;providerSlug:string;accounts:PublicationDestinationAccount[]};
function publicationDestinationGroups(destinations:PublicationWorkspaceDestination[]):PublicationDestinationPlatform[]{
  const platforms=new Map<string,PublicationDestinationPlatform>();
  // The destination projection is the account authority. Unlinked targets and
  // non-publishing services (for example, messaging endpoints) never appear in
  // the publishing picker. A saved selection that is temporarily unavailable
  // stays visible so its owner can explicitly remove it without losing drafts.
  for(const destination of destinations.filter(row=>(row.ready===true&&row.publishable===true)||(row.selected===true&&(row.ready!==true||row.publishable!==true||row.unavailable===true)))){
    const plain=destination.label.trim();
    const label=destination.groupLabel?.trim()||plain.split(/\s*[.(/]\s*/)[0].trim()||plain;
    const id=normalizeProviderSlug(destination.providerSlug||label);
    let platform=platforms.get(id);
    if(!platform){platform={id,label,providerSlug:destination.providerSlug||id,accounts:[]};platforms.set(id,platform);}
    const accountId=destination.accountId||destination.serviceConnectionRef||destination.accountLabel||'__current-connected-account__';
    let account=platform.accounts.find(row=>row.id===accountId);
    if(!account){account={id:accountId,label:destination.accountLabel?.trim()||'Connected account',formats:[]};platform.accounts.push(account);}
    const inferredFormat=plain.toLocaleLowerCase().startsWith(label.toLocaleLowerCase())
      ?plain.slice(label.length).replace(/^[\s.(/-]+|[).]+$/g,'').trim()
      :plain;
    account.formats.push(destination.formatLabel?.trim()?{...destination,label:destination.formatLabel.trim()}:inferredFormat?{...destination,label:inferredFormat}:destination);
  }
  return [...platforms.values()].map(platform=>({...platform,accounts:platform.accounts.map(account=>({...account,formats:[...account.formats]}))}))
    .sort((a,b)=>a.label.localeCompare(b.label));
}
export function mountPublicationWorkspace(node:HTMLElement,options:PublicationWorkspaceOptions){
  const label=options.label||'Publish video';
  const expanded=new Set<string>();
  let initialized=false;
  const draw=(current:PublicationWorkspaceOptions)=>{
    const groups=publicationDestinationGroups(current.destinations);
    const providerIcons=current.providerIconRegistry??providerIconRegistry;
    if(!initialized&&groups.length){
      for(const group of groups.slice(0,2))expanded.add(group.id);
      initialized=true;
    }
    for(const group of groups){
      const selectedAccount=group.accounts.find(account=>account.formats.some(destination=>destination.selected));
      if(selectedAccount){expanded.add(group.id);expanded.add(`${group.id}:${selectedAccount.id}`);}
    }
    const selectedDestination=current.destinations.find(destination=>destination.selected&&destination.ready===true&&destination.publishable===true);
    return mount(node,<section className="coss-publication-workspace" aria-label={current.label||label}>
    <header className="coss-publication-workspace-header">
      <div><h2>{current.title}</h2>{current.summary&&<p>{current.summary}</p>}</div>
      <div className="coss-publication-destination-rail" role="group" aria-label="Publishing destinations">
        {groups.length?groups.map(group=><details key={group.id} className="coss-publication-destination-group" open={expanded.has(group.id)} onToggle={event=>{if(event.currentTarget.open)expanded.add(group.id);else expanded.delete(group.id);}}>
          <summary className="coss-publication-destination-group-heading"><ProviderMark providerSlug={group.providerSlug} providerName={group.label} registry={providerIcons} size="sm" decorative/><strong>{group.label}</strong><small>{group.accounts.length}</small><ChevronRight aria-hidden="true"/></summary>
          <div className="coss-publication-account-list" role="group" aria-label={`${group.label} accounts`}>
            {group.accounts.map(account=><details key={account.id} className="coss-publication-account" open={expanded.has(`${group.id}:${account.id}`)} onToggle={event=>{if(event.currentTarget.open)expanded.add(`${group.id}:${account.id}`);else expanded.delete(`${group.id}:${account.id}`);}}>
              <summary className="coss-publication-account-heading"><ProviderMark providerSlug={group.providerSlug} providerName={group.label} registry={providerIcons} size="xs" decorative/><span>{account.label}</span><small>{account.formats.length}</small><ChevronRight aria-hidden="true"/></summary>
              <div className="coss-publication-destination-choices" role="group" aria-label={`${account.label} formats`}>
                {account.formats.map(destination=>{const unavailable=destination.unavailable===true||destination.ready!==true||destination.publishable!==true;const status=destination.unavailable?'Unavailable':destination.ready!==true?'Not connected':'Not available for publishing';return <Tooltip key={destination.id} label={unavailable?(destination.detail||status):destination.label}><Button type="button" variant="outline" className={`coss-publication-destination${unavailable?' is-unavailable':''}`} aria-pressed={destination.selected} aria-label={unavailable?`${destination.label} . ${status}`:destination.label} onClick={()=>current.onDestination?.(destination.id)}>
                  <span className="coss-publication-destination-name">{destination.label}</span>
                  {unavailable&&<small className="coss-publication-destination-status">{status}</small>}
                </Button></Tooltip>})}
              </div>
            </details>)}
          </div>
        </details>):<p className="coss-publication-destination-empty">Link an account to publish.</p>}
      </div>
    </header>
    <div className="coss-publication-workspace-body">
      <nav className="coss-publication-stage-rail" aria-label="Publishing steps">
        {current.stages.map(stage=><Button key={stage.id} type="button" variant="ghost" className="coss-publication-stage" aria-current={current.activeStage===stage.id?'step':undefined} onClick={()=>current.onStage?.(stage.id)}>
          <span>{stage.label}</span>{stage.detail&&<small>{stage.detail}</small>}
        </Button>)}
      </nav>
      <Card className="coss-publication-stage-content"><CardPanel><div data-publication-content-host="">{selectedDestination?.content??current.content}</div></CardPanel></Card>
    </div>
    {!!current.actions?.length&&<footer className="coss-publication-action-rail" role="group" aria-label="Publishing actions">
      {current.actions.map(action=><Button key={action.id} type="button" variant={action.primary?'default':'outline'} disabled={action.disabled} onClick={()=>current.onAction?.(action.id)}>{action.label}</Button>)}
    </footer>}
  </section>);
  };
  draw(options);
  return {
    get contentHost(){return node.querySelector<HTMLElement>('[data-publication-content-host]');},
    update(next:Partial<PublicationWorkspaceOptions>){options={...options,...next};draw(options);},
  };
}

// Every menu mounted from application code renders through the shared
// ActionMenu, so each row carries an icon, groups, tone and shortcut hints.
// A menu is not a list, so it gets no empty state: the right answer to having
// no actions is not to offer the button. A trigger that opens an empty popup
// is a control that lies about being useful, which is worse than its absence.
export type MountMenuOptions={label?:string;items:ActionMenuItem[];onAction:(id:string)=>void;onOpenChange?:(open:boolean)=>void;icon?:boolean;triggerProps?:Record<string,unknown>;scope?:string;showGroupLabels?:boolean;bindShortcuts?:boolean;
  /** Open at this viewport point (beside the control the person pressed) with no trigger of its own. */
  anchor?:{x:number;y:number}};
export function mountMenu(node:HTMLElement,{label='More actions',items,onAction,onOpenChange,icon=true,triggerProps={},scope,showGroupLabels=false,bindShortcuts=true,anchor}:MountMenuOptions){
  if(!items?.length){releaseNode(node);node.replaceChildren();return;}
  checkActionMenuItems(items,scope);
  const state=menuStates.get(node)||{open:false};menuStates.set(node,state);
  const surface:FloatingSurface={close:()=>setOpen(false)};
  function setOpen(value:boolean){
    if(state.open===value)return;state.open=value;
    if(value)claimFloatingSurface(surface);else releaseFloatingSurface(surface);
    render();onOpenChange?.(value);
  }
  const render=()=>mount(node,<ActionMenu label={label} items={items} onAction={onAction} scope={scope} showGroupLabels={showGroupLabels} bindShortcuts={bindShortcuts} iconTrigger={icon} triggerProps={triggerProps} anchorPoint={anchor} open={state.open} onOpenChange={setOpen}/>);
  render();return {open:()=>setOpen(true),close:()=>setOpen(false)};
}

// Menu rows described on DOM sources (a select's options, a group of buttons)
// carry the same DATA as attributes: data-menu-icon, data-menu-group,
// data-menu-group-label, data-menu-tone, data-menu-target, data-menu-confirm and
// data-menu-shortcut (JSON {"key":"Backspace","modifiers":["meta"]}).
function menuRowFromElement(element:HTMLElement,id:string,label:string,disabled:boolean,fallbackGroup?:string):ActionMenuItem{
  const data=element.dataset,shortcut=data.menuShortcut?JSON.parse(data.menuShortcut) as ActionShortcut:undefined;
  return {id,label,disabled,icon:data.menuIcon||'',group:data.menuGroup||fallbackGroup,groupLabel:data.menuGroupLabel||fallbackGroup,tone:data.menuTone,target:data.menuTarget,confirm:data.menuConfirm,shortcut};
}

// The native select stays the value/event owner. <optgroup> labels become menu
// groups; each option describes its row through data-menu-* attributes.
export function actionSelectItems(select:HTMLSelectElement):ActionMenuItem[]{
  return [...select.options].filter(option=>option.value).map(option=>menuRowFromElement(option,option.value,option.text,option.disabled,option.parentElement instanceof HTMLOptGroupElement?option.parentElement.label:undefined));
}

export function enhanceActionSelect(select:HTMLSelectElement,label='More actions',{scope}:{scope?:string}={}){
  if(!select||select.dataset.menuBound)return;select.dataset.menuBound='true';select.hidden=true;
  const host=document.createElement('div');host.className='ui-action-menu coss-action-menu';select.after(host);
  const api=mountMenu(host,{label,scope,items:actionSelectItems(select),onAction:(id:string)=>{select.value=id;select.dispatchEvent(new Event('change',{bubbles:true}));}});
  Object.defineProperty(host,'open',{set:value=>{if(value)api?.open();}});
  return host;
}

export function enhanceButtonGroup(node:HTMLElement|null,label:string,{icon=false,omitDisabled=false,scope}:{icon?:boolean;omitDisabled?:boolean;scope?:string}={}){
  if(!node)return;
  const host=document.createElement('span');
  node.after(host);node.hidden=true;node.classList.add('source-owned-actions');
  const render=()=>{const actions=[...node.querySelectorAll('button')].filter(button=>!button.hidden&&(!omitDisabled||!button.disabled)).map(button=>({button,label:button.textContent?.trim()||button.getAttribute('aria-label')?.trim()||button.title?.trim()})).filter(action=>action.label);return mountMenu(host,{label,icon,scope,items:actions.map((action,index)=>menuRowFromElement(action.button,String(index),action.label!,action.button.disabled)),onAction:(id:string)=>actions[Number(id)]?.button.click()});};
  render();const observer=new MutationObserver(render);observer.observe(node,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','hidden','data-menu-icon','data-menu-group','data-menu-tone','data-menu-target','data-menu-shortcut','data-menu-confirm']});
  disposers.set(host,()=>observer.disconnect());
}

const PROJECT_ICON_CHOICES=[
  {icon:'📁',label:'Folder'},
  {icon:'🎯',label:'Focus'},
  {icon:'🚀',label:'Launch'},
  {icon:'🎬',label:'Video'},
  {icon:'✨',label:'Sparkles'},
  {icon:'🧠',label:'Brain'},
  {icon:'⭐',label:'Star'},
  {icon:'💡',label:'Idea'},
];

/** A project or place is a thing: its picture, the emoji the person chose for it, or a folder, never its letters. */
function projectMark(item:{name?:string;image?:string;icon?:string;color?:string}){
  return {name:item.name||'Project',shape:'tile' as const,...(item.image?{image:item.image}:{}),...(item.icon?{monogram:item.icon}:{glyph:'Folder'}),...(item.color?{tint:{background:item.color}}:{})};
}

export function mountProjects(node:HTMLElement,{items,onOpen,onSetIcon,empty}:any){
  if(!items?.length)return mount(node,<EmptyState {...(empty||{})}/>);
  mount(node,<div className="coss-projects">{items.map((item:any)=><Card key={item.id} className="coss-project-card" data-project={item.id}>
    <Button type="button" variant="ghost" className="coss-project-open h-auto min-h-0 min-w-0 flex-1 justify-start rounded-none px-0 py-0 text-left shadow-none hover:bg-transparent" onClick={()=>onOpen?.(item.id)}>
      <DisplayMark key={item.image??''} spec={projectMark(item)} size="md"/>
      <span className="coss-project-name">{item.name}</span><ChevronRight aria-hidden="true" size={15}/>
    </Button>
    {onSetIcon&&<ActionMenu label={`Change icon for ${item.name}`} trigger={<Button type="button" variant="ghost" size="icon" className="coss-project-icon-action h-11 w-11 shrink-0 sm:h-8 sm:w-8"/>} triggerContent={<Pencil aria-hidden="true" size={15}/>}
      items={[...PROJECT_ICON_CHOICES.map(choice=>({id:choice.icon,label:choice.label,icon:{glyph:choice.icon},group:'choices'})),{id:'',label:'Use the folder',icon:'folder',group:'reset'}]}
      onAction={id=>onSetIcon(item.id,id)}/>}
  </Card>)}</div>);
}

function MediaPoster({src}: {src?:string}){
  const [failed,setFailed]=React.useState(false);
  React.useEffect(()=>setFailed(false),[src]);
  return <span className="coss-media-poster">{src&&!failed?<img src={src} loading="lazy" alt="" onError={()=>setFailed(true)}/>:failed?<ImageOff aria-label="Preview unavailable"/>:<FileVideo aria-hidden="true"/>}</span>;
}
const marqueeSelections=new WeakMap<HTMLElement,{destroy:()=>void}>();
export function mountMediaGrid(node:HTMLElement,{items=[],groups,selected=[],onSelect,onSelectionGesture,onMarqueeSelect,selectionMode=false,marqueeSelection=false,onOpen,onInsert,onAction,quiet=false,layout='grid',onActiveChange,initialId,persistentAction,dragType,onDragData,label='Editable videos',empty}:any){
  // Groups can be present while every group is empty, so this counts what
  // would actually be drawn rather than trusting either argument alone.
  if(!items.length&&!(groups||[]).some((group:any)=>group?.items?.length))return mount(node,<EmptyState {...(empty||{})}/>);
  const chosen=new Set(selected);
  marqueeSelections.get(node)?.destroy();marqueeSelections.delete(node);
  if(onMarqueeSelect&&layout!=='carousel')marqueeSelections.set(node,mountMarqueeSelection(node,{enabled:()=>selectionMode||marqueeSelection,onSelect:onMarqueeSelect}));
  const open=(event:React.MouseEvent,item:any)=>{if(onSelectionGesture&&(selectionMode||event.shiftKey||event.metaKey||event.ctrlKey)){event.preventDefault();onSelectionGesture(item.id,{range:event.shiftKey,toggle:event.metaKey||event.ctrlKey});return;}(onInsert||onOpen)?.(item.id);};
  const renderItem=(item:any)=><Card key={item.id} className="coss-media-card mw-card" data-quiet={quiet?'':undefined} data-layout={layout} data-selected={chosen.has(item.id)?'':undefined} draggable={Boolean(dragType&&onDragData)} onDragStart={event=>{if(!dragType||!onDragData)return;beginMediaDrag(event.dataTransfer,dragType,onDragData(item.id));}}>
    {onSelect&&<Checkbox className="coss-media-select" aria-label={'Select '+item.title} data-pick={item.id} checked={chosen.has(item.id)} onCheckedChange={checked=>onSelect(item.id,checked)}/>}
    <Tooltip label={onInsert?'Click to insert · Drag to place':item.title}><Button variant="ghost" className="coss-media-open" aria-label={onInsert?'Insert '+item.title:item.title} data-preview={item.id} data-no-poster={item.showPoster===false?'':undefined} disabled={item.openDisabled||!(onInsert||onOpen)} onClick={event=>open(event,item)}>
      {item.showPoster!==false&&<MediaPoster src={item.poster}/>}
      {(!quiet||item.showPoster===false)&&<strong>{item.title}</strong>}
      {item.detail&&<small>{item.detail}</small>}
    </Button></Tooltip>
    {!!item.metadata?.length&&<span className="coss-media-metadata">
      {item.metadata.slice(0,1).map((meta:any)=><Tooltip key={meta.id||meta.label} label={meta.title||meta.label} side="top"><Badge render={<button type="button"/>} variant={meta.action==='organize'?'warning':'outline'} size="lg" className="coss-media-metadata-chip" onClick={()=>onAction?.(item.id,meta.action||`metadata:${meta.id}`)}>{meta.color&&<span className="coss-media-metadata-color" style={{backgroundColor:meta.color}} aria-hidden="true"/>}<span className="coss-media-metadata-label">{meta.label}</span></Badge></Tooltip>)}
      {item.metadata.length>1&&<ActionMenu label={`Show ${item.metadata.length-1} more labels for ${item.title}`} align="start" side="top" trigger={<Button type="button" variant="secondary" size="sm" className="coss-media-metadata-more"/>} triggerContent={<>+{item.metadata.length-1}</>}
        items={item.metadata.slice(1).map((meta:any)=>({id:meta.action||`metadata:${meta.id}`,label:meta.label,icon:meta.color?{glyph:<span className="coss-media-metadata-color" style={{backgroundColor:meta.color}}/>}:(meta.icon||'tag')}))}
        onAction={id=>onAction?.(item.id,id)}/>}
    </span>}
    {!!item.menuActions?.length&&<ActionMenu label={'Actions for '+item.title} trigger={<Button type="button" variant="secondary" size="icon" className="coss-media-card-menu"/>} triggerContent={<MoreHorizontal size={17}/>} items={item.menuActions} onAction={id=>onAction?.(item.id,id)}/>}
    {onInsert&&onOpen&&<Tooltip label={'Preview '+item.title}><Button variant="secondary" size="icon" className="coss-media-preview-action" aria-label={'Preview '+item.title} onClick={()=>onOpen(item.id)}><Eye size={16}/></Button></Tooltip>}
    {!!item.actions?.length&&<CardFooter className="coss-media-actions" role="group" aria-label={'Actions for '+item.title}>
      {item.actions.map((action:any)=><Button key={action.id} variant={action.variant||'outline'} size="sm" disabled={action.disabled} data-item-action={action.id} onClick={()=>onAction?.(item.id,action.id)}>{action.label}</Button>)}
    </CardFooter>}
  </Card>;
  mount(node,layout==='carousel'?<RotatingCarousel items={items} renderItem={renderItem} renderActiveAction={persistentAction?(item:any)=><Button className="source-carousel-action" disabled={item.openDisabled} onClick={()=>onAction?.(item.id,persistentAction.id)}>{persistentAction.label}</Button>:undefined} onActiveChange={onActiveChange} initialId={initialId} label={label}/>:<>{groups?groups.map((group:any,index:number)=><React.Fragment key={group.id??group.label??index}><h3 className="coss-media-group-title">{group.label}</h3>{group.items.map(renderItem)}</React.Fragment>):items.map(renderItem)}</>);
}

export function mountMediaMetadata(node:HTMLElement,{items=[],onAction,label='Labels'}:any){
  mount(node,<div className="coss-ui coss-media-metadata" aria-label={label}><h3 className="coss-media-metadata-heading">{label}</h3>{items.map((item:any)=><Tooltip key={item.id||item.label} label={item.title||item.label} side="top"><Badge render={<button type="button"/>} variant={item.action==='organize'?'warning':'outline'} size="lg" className="coss-media-metadata-chip" onClick={()=>onAction?.(item.action||`metadata:${item.id}`)}>{item.color&&<span className="coss-media-metadata-color" style={{backgroundColor:item.color}} aria-hidden="true"/>}<span className="coss-media-metadata-label">{item.label}</span></Badge></Tooltip>)}</div>);
}

// Hosts that draw by call rather than through loadScreen (the Mac app's plain-script screens) say "nothing here" and
// "still loading" with these two. They draw nothing of their own: both hand the state to the one screen-state part, so
// an empty, failed or loading state here looks and waits exactly like one on a Trillion screen. A failed state there
// always offers its way forward, so an error that came without an action is drawn as an answer carrying the alert icon.
export type EmptyOptions=Omit<EmptyStateOptions,'icon'>&{icon?:string};
export function mountEmpty(node:HTMLElement,{title=NOTHING_HERE_YET,description,action,onAction,tone='empty',icon}:EmptyOptions={}){
  const forward=action&&onAction?{label:action,run:onAction}:undefined;
  const state:ScreenStateValue=tone==='error'&&forward
    ?{status:'failed',title,description,icon,retry:forward}
    :{status:'empty',title,description,icon:icon??(tone==='error'?'CircleAlert':undefined),action:forward};
  mount(node,<ScreenState state={state}/>);
}

export function mountMediaLoading(node:HTMLElement,{label='Loading recordings',layout='gallery'}:{label?:string;layout?:LoadingLayout}={}){
  mount(node,<ScreenState state={{status:'loading',label,layout}}/>);
}

export function mountNavigation(node:HTMLElement,{items,selected,onOpen,label='Projects'}:any){
  mount(node,<nav className="coss-navigation" aria-label={label}>{items.map((item:any)=><Button key={item.id} variant="ghost" className="coss-navigation-item" data-item={item.id} aria-current={selected===item.id?'page':undefined} onClick={()=>onOpen(item.id)}>
    {item.icon!==false&&<DisplayMark spec={projectMark(item)} size="sm"/>}<span><span>{item.name}</span>{item.detail&&<small className="coss-navigation-detail">{item.detail}</small>}</span>
  </Button>)}</nav>);
}

// `empty` is how a caller says what nothing means here. Without it the list
// still says something rather than painting an empty box, which is what every
// one of these call sites used to do.
function ActionCards({items,onAction,label}:any){
  const [pending,setPending]=React.useState<Map<string,string>>(()=>new Map());
  const inFlight=React.useRef(new Set<string>());
  const finish=(itemId:string)=>{
    inFlight.current.delete(itemId);
    setPending(previous=>{if(!previous.has(itemId))return previous;const next=new Map(previous);next.delete(itemId);return next;});
  };
  const run=(item:any,action:any)=>{
    const itemId=String(item.id);
    if(inFlight.current.has(itemId))return;
    inFlight.current.add(itemId);
    let result:any;
    try{result=onAction?.(item.id,action.id);}
    catch(error){finish(itemId);throw error;}
    if(!result||typeof result.then!=='function'){finish(itemId);return result;}
    setPending(previous=>new Map(previous).set(itemId,String(action.id)));
    return Promise.resolve(result).finally(()=>finish(itemId));
  };
  return <section className="coss-action-cards" aria-label={label}>{items.map((item:any)=><Card key={item.id} className="coss-action-card" data-selected={item.selected===true?'':undefined}>
    {item.poster&&<img className="coss-action-thumbnail" src={item.poster} alt={item.posterAlt||''} loading="lazy"/>}
    <p>{item.title}</p>{item.detail&&<small>{item.detail}</small>}
    <div role="group" aria-label={'Actions for '+item.title}>{(item.actions||[]).map((action:any)=>{
      const itemId=String(item.id),activeAction=pending.get(itemId),loading=Boolean(action.loading||activeAction===String(action.id));
      const loadingLabel=action.loadingLabel||`${action.label}…`;
      return <React.Fragment key={action.id}><Button variant="outline" size="sm" disabled={action.disabled||Boolean(activeAction)||loading} loading={loading} aria-busy={loading||undefined} aria-label={loading?loadingLabel:undefined} onClick={()=>void run(item,action)}>{action.label}</Button>{loading&&<span className="coss-action-loading" role="status" aria-live="polite">{loadingLabel}</span>}</React.Fragment>;
    })}</div>
  </Card>)}</section>;
}

export function mountActionCards(node:HTMLElement,{items,onAction,label='Saved choices',empty}:any){
  if(!items?.length)return mount(node,<EmptyState {...(empty||{})}/>);
  mount(node,<ActionCards items={items} onAction={onAction} label={label}/>);
}

export function mountCalendarGrid(node:HTMLElement,options:{cells:CalendarGridCell[];columns?:number;columnLabels?:string[];density?:CalendarGridDensity;countLimit?:number;ariaLabel:string;onSelectCell?:(key:string)=>void}){
  const {cells,columns,columnLabels,density='compact',countLimit,ariaLabel,onSelectCell}=options;
  return mountSharedContent(node,<CalendarGrid cells={cells} columns={columns} columnLabels={columnLabels} density={density} countLimit={countLimit} ariaLabel={ariaLabel} onSelectCell={onSelectCell}/>);
}

/** Mount the shared hourly calendar geometry into any application host. */
export function mountHourGrid(node:HTMLElement,options:{lanes:HourGridLane[];windowStartMinute?:number;windowEndMinute?:number;hourHeightPx?:number;minLaneWidthPx?:number;nowMinute?:number;onSelectItem?:(key:string)=>void}){
  const {lanes,windowStartMinute=420,windowEndMinute=1260,hourHeightPx=48,minLaneWidthPx=180,nowMinute,onSelectItem}=options;
  const labelHour=(hour:number)=>new Date(Date.UTC(2026,0,1,hour)).toLocaleTimeString(undefined,{timeZone:'UTC',hour:'numeric'});
  return mountSharedContent(node,<HourGrid lanes={lanes} windowStartMinute={windowStartMinute} windowEndMinute={windowEndMinute}
    hourHeightPx={hourHeightPx} minLaneWidthPx={minLaneWidthPx} nowMinute={nowMinute}
    formatHourLabel={labelHour} onSelectItem={onSelectItem}/>);
}

export {mountRecordEditor} from './record-editor';
