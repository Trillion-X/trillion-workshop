import React,{useCallback,useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DropdownMenu,DropdownMenuTrigger,DropdownMenuContent} from '../assistant-ui/source/components/react/ui/base/dropdown-menu';
import {SidebarProvider,Sidebar,SidebarContent,SidebarFooter,SidebarGroup,SidebarMenu,SidebarMenuItem,SidebarMenuButton,SidebarTrigger,useSidebar} from '../assistant-ui/source/components/react/ui/base/sidebar';
import {Home,Search,Library,Folder,HardDrive,Activity,Info,FileText,Film,Archive,SunMoon} from 'lucide-react';

const icons:any={Home,Search,Library,Projects:Folder,Drives:HardDrive,'Live activity':Activity,Info,Transcripts:FileText,Drafts:Film,Archive,'Toggle light and dark theme':SunMoon};
export type NavigationEntry={label:string;page?:string;run:()=>void;footer?:boolean;mountPanel?:(host:HTMLElement,close:()=>void)=>{destroy?:()=>void}|void};
const readSavedWidth=()=>{try{const saved=Number(window.localStorage.getItem('app-navigation-width'));return saved>=152&&saved<=360?saved:192;}catch{return 192;}};
const saveWidth=(width:number)=>{try{window.localStorage.setItem('app-navigation-width',String(width));}catch{}}
function PanelEntry({item,active}:{item:NavigationEntry;active:string}){
 const {setOpenMobile}=useSidebar(),[open,setOpen]=useState(false),[panelHost,setPanelHost]=useState<HTMLDivElement|null>(null);
 const close=useCallback(()=>{setOpen(false);setOpenMobile(false);},[setOpenMobile]);
 useEffect(()=>{if(!open||!panelHost)return;const mounted=item.mountPanel?.(panelHost,close);return()=>mounted?.destroy?.();},[open,panelHost,item,close]);
 return <SidebarMenuItem><DropdownMenu open={open} onOpenChange={setOpen}><DropdownMenuTrigger aria-label={item.label} render={<SidebarMenuButton isActive={item.page===active}/>}> <Folder/><span>{item.label}</span></DropdownMenuTrigger><DropdownMenuContent className="source-conversation app-navigation-panel" side="right" align="start"><div ref={setPanelHost}/></DropdownMenuContent></DropdownMenu></SidebarMenuItem>;
}
function Items({items,active}: {items:NavigationEntry[];active:string}){
 const {setOpenMobile}=useSidebar();
 return <SidebarMenu>{items.map(item=>{if(item.mountPanel)return <PanelEntry key={item.label} item={item} active={active}/>;const Icon=icons[item.label]||Library,label=item.label==='Toggle light and dark theme'?'Appearance':item.label;return <SidebarMenuItem key={item.label}><SidebarMenuButton aria-label={label} isActive={!!item.page&&item.page===active} onClick={()=>{item.run();setOpenMobile(false);}}><Icon/><span>{label}</span></SidebarMenuButton></SidebarMenuItem>;})}</SidebarMenu>;
}
function Placement({width}:{width:number}){
 const {open,isMobile}=useSidebar();
 useEffect(()=>{document.documentElement.style.setProperty('--rail',isMobile||!open?'0px':width+'px');document.documentElement.toggleAttribute('data-navigation-hidden',!isMobile&&!open);return ()=>{document.documentElement.style.removeProperty('--rail');document.documentElement.removeAttribute('data-navigation-hidden');};},[open,isMobile,width]);
 return isMobile||!open?<SidebarTrigger aria-label="Open navigation"/>:null;
}
function ResizeRail({width,onChange}:{width:number;onChange:(width:number)=>void}){
 const {open,isMobile}=useSidebar();if(!open||isMobile)return null;
 const start=(event:React.PointerEvent)=>{event.preventDefault();const initial=event.clientX,current=width,move=(next:PointerEvent)=>onChange(Math.max(152,Math.min(360,current+next.clientX-initial))),finish=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);document.body.style.removeProperty('user-select');};document.body.style.userSelect='none';window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish,{once:true});};
 return <div className="app-navigation-resize" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={152} aria-valuemax={360} aria-valuenow={width} tabIndex={0} onPointerDown={start} onDoubleClick={()=>onChange(192)} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();onChange(Math.max(152,Math.min(360,width+(event.key==='ArrowRight'?16:-16))));}}}/>;
}
function Navigation({items}: {items:NavigationEntry[]}){
 const [active,setActive]=useState(document.querySelector('.page.active')?.id||'home');
 const [width,setWidth]=useState(readSavedWidth),resize=(value:number)=>{setWidth(value);saveWidth(value);};
 useEffect(()=>{const update=()=>setActive(document.querySelector('.page.active')?.id||'home');const observer=new MutationObserver(update);document.querySelectorAll('.page').forEach(page=>observer.observe(page,{attributes:true,attributeFilter:['class']}));update();return()=>observer.disconnect();},[]);
 return <SidebarProvider defaultOpen={true} style={{'--sidebar-width':width+'px'} as React.CSSProperties}><Sidebar collapsible="offcanvas"><SidebarContent><SidebarGroup><Items items={items.filter(item=>!item.footer)} active={active}/></SidebarGroup></SidebarContent><SidebarFooter><Items items={items.filter(item=>item.footer)} active={active}/></SidebarFooter></Sidebar><ResizeRail width={width} onChange={resize}/><Placement width={width}/></SidebarProvider>;
}
/** `nativeChrome`: the host window draws its own title bar controls over the page, so the rail and shell start below them. */
export function replaceNavigation(items:NavigationEntry[],{nativeChrome=false}:{nativeChrome?:boolean}={}){
 if(!document.querySelector('.shell'))return;
 const shell=document.querySelector<HTMLElement>('.shell');
 shell?.toggleAttribute('data-native-chrome',nativeChrome);
 const host=document.createElement('aside');host.className='source-conversation app-navigation';host.setAttribute('aria-label','Primary navigation');host.toggleAttribute('data-native-chrome',nativeChrome);document.body.prepend(host);
 // Upstream Sheet portals render outside the host. Scope their original theme
 // at the portal boundary, without changing upstream component files.
 const portals=new MutationObserver(()=>{document.querySelectorAll<HTMLElement>('[data-base-ui-portal]').forEach(portal=>{if(portal.querySelector('[data-sidebar="sidebar"]')){portal.classList.add('source-conversation');portal.toggleAttribute('data-native-chrome',host.hasAttribute('data-native-chrome'));}});});portals.observe(document.body,{childList:true,subtree:true});
 createRoot(host).render(<Navigation items={items}/>);
}
