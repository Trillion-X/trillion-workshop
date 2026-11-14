import React from 'react';
import {RecordKindMark} from '../record-kind';
import {NamedIcon} from '../icon/NamedIcon';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {AnimatePresence,m as motion,useReducedMotion} from 'framer-motion';
import { MotionFeatures } from 'trillion-workshop/tools/ui/motion/lazy-motion.tsx'
import {ChevronRight,Clapperboard,Folder,FolderInput,FolderOpen,FolderPlus,Pencil,Plus,Search,Trash2,X} from 'lucide-react';
import {Button} from './ui/button';
import {Checkbox} from './ui/checkbox';
import {Input} from './ui/input';
import {Textarea} from './ui/textarea';
import {ActionMenu} from '../action-menu';
import {NestingGuide} from '../nesting-guide';
import {SurfacePreviewCard} from '../surface-preview/SurfacePreviewCard';
import {fillSurfaceAction,readGlanceDeclaration,readSurfaceActions,runSurfaceAction} from '../surface-preview/surface-glance';

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
export type ProjectTreeItem={
  id:string;
  name:string;
  children?:string[];
  kind?:string;
  detail?:string;
  /** What kind of thing this is (the record's own record_kind), drawn beside the name. */
  recordKind?:{kind:string;detail?:string};
  description?:string;
  icon?:string;
  thumbnail?:string;
  /** A Lucide icon name drawn for the row instead of its folder mark (a file's kind, say). */
  namedIcon?:string;
  /** The colour its icon is drawn in: a tone of the shared look (blue, green, purple, yellow, red), from the caller's DATA. */
  tone?:string;
  /** The row has children the tree has not read yet: it shows a disclosure, and opening it asks loadChildren. */
  expandable?:boolean;
  selectable?:boolean;
  manageable?:boolean;
  /** A row that never holds other rows (an action in a list of actions): nothing is made, moved or dropped inside it. */
  leaf?:boolean;
  /** Its only detail is its name: Rename instead of Edit details, even when the tree can edit details. */
  nameOnly?:boolean;
};

/** Every word the tree shows, so a tree of anything (projects, folders, saved actions) speaks about its own rows.
 *  `{name}` is the row's name. */
export type ProjectTreeWords={
  newInside:string;newTopLevelPlaceholder:string;newInsidePlaceholder:string;add:string;cancelNew:string;
  editDetails:string;rename:string;move:string;moveUp:string;moveDown:string;linkElsewhere:string;remove:string;
  moveInto:string;topLevel:string;cancelMove:string;linkInto:string;cancelLink:string;
  detailsName:string;detailsIcon:string;detailsDescription:string;detailsDescriptionPlaceholder:string;saveDetails:string;cancel:string;save:string;cancelRename:string;
  removeConfirm:string;removeButton:string;cancelRemove:string;noMatch:string;
};

/** A kind of row the tree makes: its New button (`label`) and its row in a folder's menu (`inside`). Each kind's
 *  create form says `placeholder`; onCreate hears the kind's id. */
export type ProjectTreeCreateKind={id:string;label:string;inside:string;placeholder:string;insidePlaceholder?:string;icon?:string};

const defaultWords:ProjectTreeWords={
  newInside:'New folder inside',newTopLevelPlaceholder:'Top-level folder',newInsidePlaceholder:'Folder inside selected project',add:'Add',cancelNew:'Cancel new folder',
  editDetails:'Edit details',rename:'Rename',move:'Move',moveUp:'Move up',moveDown:'Move down',linkElsewhere:'Add to another group',remove:'Remove',
  moveInto:'Move {name} into…',topLevel:'Top level',cancelMove:'Cancel move',linkInto:'Add {name} to another group…',cancelLink:'Cancel add to another group',
  detailsName:'Name',detailsIcon:'Icon',detailsDescription:'What belongs here?',detailsDescriptionPlaceholder:'Describe this project so automatic organization can learn where recordings belong.',saveDetails:'Save details',cancel:'Cancel',save:'Save',cancelRename:'Cancel rename',
  removeConfirm:'Remove from this list? Files stay on disk.',removeButton:'Remove',cancelRemove:'Cancel remove',noMatch:'No matching projects',
};
const named=(template:string,name:string)=>template.split('{name}').join(name);

export type ProjectTreeOptions={
  items:ProjectTreeItem[];
  roots?:string[];
  selected?:string[];
  label?:string;
  /** 'none' makes the tree a navigator: no checkboxes, and choosing a row opens it (onOpen). */
  selectionMode?:'single'|'multiple'|'none';
  /** Choosing a row in a navigator tree. */
  onOpen?:(id:string)=>void;
  /** Reads one expandable row's children the first time it is opened, and again on refresh. */
  loadChildren?:(id:string)=>Promise<ProjectTreeItem[]>;
  /** The search box's words and what an empty tree says; they default to the project picker's. */
  searchLabel?:string;
  emptyLabel?:string;
  allowEmptySelection?:boolean;
  searchable?:boolean;
  closeOnSelect?:boolean;
  onSelectionChange?:(ids:string[])=>void;
  /** Makes a row named `name` inside `parentId` (null: at the top), of `kind` (an id from createKinds). */
  onCreate?:(parentId:string|null,name:string,kind:string)=>Promise<ProjectTreeItem|void>|ProjectTreeItem|void;
  /** The kinds of row the tree makes; left out, one: a folder (the tree's own words). */
  createKinds?:ProjectTreeCreateKind[];
  /** Puts `id` inside `parentId` (null: the top), just before the row `beforeId` (null: last). Given, rows can be
   *  dragged (onto the top half of a row: before it; onto a row that holds rows: inside it, last) and moved up or down
   *  from their menu. */
  onReorder?:(id:string,parentId:string|null,beforeId:string|null)=>Promise<void>|void;
  /** The tree's own words, over the defaults (which speak about projects and folders). */
  words?:Partial<ProjectTreeWords>;
  /** Whether Edit details asks for an icon (it does unless this is false). */
  detailsIcon?:boolean;
  onRename?:(id:string,name:string)=>Promise<ProjectTreeItem|void>|ProjectTreeItem|void;
  onEdit?:(id:string,value:{name:string;description:string;icon:string})=>Promise<ProjectTreeItem|void>|ProjectTreeItem|void;
  onMove?:(id:string,parentId:string|null)=>Promise<void>|void;
  onLink?:(id:string,parentId:string)=>Promise<void>|void;
  onDelete?:(id:string)=>Promise<void>|void;
  reload?:()=>Promise<{items:ProjectTreeItem[];roots?:string[]}>;
  placeholder?:string;
  /** Hovering a row opens the shared preview card. Raw DATA from the owning app:
   *  `glance` and `actions` as on a surface record, with `{id}` and `{name}` filled
   *  per row; `description` shows when the glance has nothing to list. Rename (or
   *  Edit details) joins the actions whenever the tree can rename. */
  rowPreview?:{glance?:unknown;actions?:unknown;description?:string};
};

/** One drawn guide segment of a row: `start` when the row is the first under the folder whose guide this is, `end`
 *  when it is the last row of that folder's open subtree. */
type GuideSegment={start:boolean;end:boolean};
/** One drawn row. `guides[level]` is the row's segment of the guide beside the open folder `level` levels in: every
 *  row under a folder carries that folder's guide, so it reads as one pill from the folder's first row to the last
 *  row of its open subtree, worked out from the rows themselves without measuring anything. */
type VisibleRow={item:ProjectTreeItem;path:string;parentPath:string|null;depth:number;hasChildren:boolean;guides:GuideSegment[]};

// The tree's motion, in one place: rows open and close with their height, the hover highlight glides between rows.
const ROW_SPRING={type:'spring' as const,stiffness:520,damping:42,mass:0.7};
const GLIDE_SPRING={type:'spring' as const,stiffness:650,damping:45};
const INSTANT={duration:0};

type TreeSelectionControl={setSelected?:(ids:string[])=>void;refresh?:()=>Promise<void>};
export function matchingProjectTreeIds(items:ProjectTreeItem[],itemMap:Map<string,ProjectTreeItem>,query:string){
  if(!query)return null;
  const parents=new Map<string,string[]>(),matches=new Set<string>(),queue:string[]=[];
  for(const item of items){
    if(item.name.toLocaleLowerCase().includes(query)){matches.add(item.id);queue.push(item.id);}
    for(const child of item.children||[]){
      if(!itemMap.has(child))continue;
      const rows=parents.get(child)||[];rows.push(item.id);parents.set(child,rows);
    }
  }
  // Reveal every ancestor of a match without recursing through customer data.
  for(let index=0;index<queue.length;index++)for(const parent of parents.get(queue[index]!)||[])if(!matches.has(parent)){matches.add(parent);queue.push(parent);}
  return matches;
}

export function buildProjectTreeRows({rootIds,itemMap,normalizedQuery,matchingIds,expanded,pathFor}:{rootIds:string[];itemMap:Map<string,ProjectTreeItem>;normalizedQuery:string;matchingIds:Set<string>|null;expanded:Set<string>;pathFor:(parentPath:string|null,ordinal:number,id:string)=>string}){
  const result:VisibleRow[]=[],activePath=new Set<string>(),stack:Array<{id:string;depth:number;parentPath:string|null;ordinal:number;exit?:boolean}>=[];
  // The rows a folder's guide runs beside: the ones a search leaves in place, so the last of them ends it.
  const shown=(ids:string[])=>ids.filter(id=>itemMap.has(id)&&(!matchingIds||matchingIds.has(id)));
  const roots=shown(rootIds);
  for(let index=roots.length-1;index>=0;index--)stack.push({id:roots[index]!,depth:0,parentPath:null,ordinal:index});
  while(stack.length){
    const frame=stack.pop()!;
    if(frame.exit){activePath.delete(frame.id);continue;}
    const item=itemMap.get(frame.id);if(!item||activePath.has(item.id))continue;
    const path=pathFor(frame.parentPath,frame.ordinal,item.id);
    const children=(item.children||[]).filter(child=>itemMap.has(child));
    result.push({item,path,parentPath:frame.parentPath,depth:frame.depth,hasChildren:children.length>0||item.expandable===true,guides:[]});
    if(normalizedQuery||expanded.has(item.id)){
      activePath.add(item.id);stack.push({...frame,exit:true});
      const under=shown(children);
      for(let index=under.length-1;index>=0;index--)stack.push({id:under[index]!,depth:frame.depth+1,parentPath:path,ordinal:index});
    }
  }
  // Rows come in reading order and a row is at most one level in from the row above it, so the guide `level` levels in
  // starts at a row whose row above is that folder (one level out) and ends at a row whose next row is that folder's
  // level or further out.
  result.forEach((row,index)=>{
    const above=index>0?result[index-1]!.depth:-1,below=index+1<result.length?result[index+1]!.depth:-1;
    row.guides=Array.from({length:row.depth},(_,level)=>({start:above===level,end:below<=level}));
  });
  return result;
}

/** The tree drawn in place inside another React part (a chooser in a popover); mountProjectTree draws it into a node. */
function ProjectTreeMoving({options,onSelected,control}:{options:ProjectTreeOptions;onSelected:(ids:string[])=>void;control?:TreeSelectionControl}){
  const [items,setItems]=React.useState(()=>options.items.map(item=>({...item,children:[...(item.children||[])]})));
  const [roots,setRoots]=React.useState(()=>[...(options.roots||[])]);
  const [selected,setSelected]=React.useState(()=>new Set(options.selected||[]));
  const [expanded,setExpanded]=React.useState(()=>new Set(options.roots||[]));
  const [query,setQuery]=React.useState('');
  const [active,setActive]=React.useState('');
  const [createParent,setCreateParent]=React.useState<string|null|undefined>(undefined);
  const [createKind,setCreateKind]=React.useState('');
  const [dragging,setDragging]=React.useState<string|null>(null);
  const [dropAt,setDropAt]=React.useState<{id:string;zone:'before'|'inside'|'after'}|null>(null);
  const words=React.useMemo(()=>({...defaultWords,...options.words}),[options.words]);
  const kinds=React.useMemo<ProjectTreeCreateKind[]>(()=>options.createKinds?.length?options.createKinds:[{id:'folder',label:'New folder',inside:words.newInside,placeholder:words.newTopLevelPlaceholder,insidePlaceholder:words.newInsidePlaceholder}],[options.createKinds,words]);
  const startCreate=(parentId:string|null,kind:string)=>{setError('');setCreateKind(kind);setCreateParent(parentId);};
  const [creating,setCreating]=React.useState(false);
  const [renaming,setRenaming]=React.useState<string|null>(null);
  const [editing,setEditing]=React.useState<string|null>(null);
  const [moving,setMoving]=React.useState<string|null>(null);
  const [linking,setLinking]=React.useState<string|null>(null);
  const [removing,setRemoving]=React.useState<string|null>(null);
  const [mutating,setMutating]=React.useState(false);
  const [error,setError]=React.useState('');
  const rowRefs=React.useRef(new Map<string,HTMLElement>());
  const reduced=useReducedMotion();
  const rowsBox=React.useRef<HTMLDivElement>(null);
  const [glide,setGlide]=React.useState<{top:number;height:number}|null>(null);
  // The highlight moves to the row under the pointer or keyboard focus, measured against the scrolling list.
  const glideTo=(element:HTMLElement)=>{const box=rowsBox.current;if(!box)return;const outer=box.getBoundingClientRect(),inner=element.getBoundingClientRect();setGlide({top:inner.top-outer.top+box.scrollTop,height:inner.height});};
  const pathRegistry=React.useRef({byParent:new Map<string,Map<string,string>>(),next:0});
  const pathFor=React.useCallback((parentPath:string|null,ordinal:number,id:string)=>{
    const parent=parentPath||'root',edge=`${ordinal}:${id}`,registry=pathRegistry.current;
    let children=registry.byParent.get(parent);if(!children){children=new Map();registry.byParent.set(parent,children);}
    let path=children.get(edge);if(!path){path=String(++registry.next);children.set(edge,path);}return path;
  },[]);
  const itemMap=React.useMemo(()=>new Map(items.map(item=>[item.id,item])),[items]);
  React.useLayoutEffect(()=>{
    if(!control)return;
    control.setSelected=ids=>{const chosen=[...new Set(ids)].filter(id=>itemMap.has(id));const next=options.selectionMode==='single'?chosen.slice(0,1):chosen;setSelected(new Set(next));onSelected(next);};
    return()=>{delete control.setSelected;};
  },[control,itemMap,options.selectionMode,onSelected]);
  const attached=React.useMemo(()=>new Set(items.flatMap(item=>item.children||[])),[items]);
  const rootIds=React.useMemo(()=>{
    const declared=roots.filter(id=>itemMap.has(id));
    const extras=items.filter(item=>!attached.has(item.id)&&!declared.includes(item.id)).map(item=>item.id);
    return [...declared,...extras];
  },[roots,items,itemMap,attached]);
  const rowPreview=React.useMemo(()=>options.rowPreview?{glance:readGlanceDeclaration(options.rowPreview.glance)||undefined,actions:readSurfaceActions(options.rowPreview.actions),description:options.rowPreview.description}:null,[options.rowPreview]);
  const normalizedQuery=query.trim().toLocaleLowerCase();
  const matchingIds=React.useMemo(()=>matchingProjectTreeIds(items,itemMap,normalizedQuery),[items,itemMap,normalizedQuery]);
  const rows=React.useMemo(()=>buildProjectTreeRows({rootIds,itemMap,normalizedQuery,matchingIds,expanded,pathFor}),[rootIds,itemMap,normalizedQuery,matchingIds,expanded,pathFor]);
  React.useEffect(()=>{if(rows.length&&!rows.some(row=>row.path===active))setActive(rows[0].path);},[rows,active]);

  const replaceTree=React.useCallback((snapshot:{items:ProjectTreeItem[];roots?:string[]})=>{
    setItems(snapshot.items.map(item=>({...item,children:[...(item.children||[])]})));
    if(snapshot.roots)setRoots([...snapshot.roots]);
  },[]);
  const reload=async()=>{if(options.reload)replaceTree(await options.reload());};
  // An expandable row's children are read when it first opens; each read replaces that row's children in place.
  const loaded=React.useRef(new Set<string>());
  const readChildren=React.useCallback(async(id:string)=>{
    if(!options.loadChildren)return;
    const children=await options.loadChildren(id);
    loaded.current.add(id);
    setItems(current=>{
      const byId=new Map(current.map(item=>[item.id,item]));
      for(const child of children)byId.set(child.id,{...byId.get(child.id),...child,children:[...(byId.get(child.id)?.children||child.children||[])]});
      const parent=byId.get(id);if(parent)byId.set(id,{...parent,children:children.map(child=>child.id)});
      return [...byId.values()];
    });
  },[options]);
  const expand=(id:string)=>{
    setExpanded(value=>new Set(value).add(id));
    if(itemMap.get(id)?.expandable&&!loaded.current.has(id))readChildren(id).catch(reason=>setError(errorWords(reason)));
  };
  const toggleExpanded=(id:string)=>{if(expanded.has(id))setExpanded(value=>{const next=new Set(value);next.delete(id);return next;});else expand(id);};
  React.useLayoutEffect(()=>{
    if(!control)return;
    // Read the tree again: the top level, then every open row that reads its own children.
    control.refresh=async()=>{await reload();await Promise.all([...expanded].filter(id=>loaded.current.has(id)).map(readChildren));};
    return()=>{delete control.refresh;};
  });

  const publish=(next:Set<string>)=>{setSelected(next);const ids=[...next];onSelected(ids);options.onSelectionChange?.(ids);};
  const toggle=(id:string)=>{
    if(itemMap.get(id)?.selectable===false)return;
    if(options.selectionMode==='none'){const item=itemMap.get(id);if(item?.expandable||item?.children?.length)toggleExpanded(id);else options.onOpen?.(id);return;}
    if(options.selectionMode==='single'){publish(selected.has(id)&&options.allowEmptySelection!==false?new Set():new Set([id]));return;}
    const next=new Set(selected);
    if(selected.has(id))next.delete(id);else next.add(id);
    publish(next);
  };
  const focus=(path:string)=>requestAnimationFrame(()=>rowRefs.current.get(path)?.focus());
  const handleKey=(event:React.KeyboardEvent,row:VisibleRow)=>{
    const index=rows.findIndex(candidate=>candidate.path===row.path);
    if(event.key==='ArrowDown'&&index<rows.length-1){event.preventDefault();focus(rows[index+1].path);}
    else if(event.key==='ArrowUp'&&index>0){event.preventDefault();focus(rows[index-1].path);}
    else if(event.key==='ArrowRight'&&row.hasChildren){event.preventDefault();if(!expanded.has(row.item.id)&&!normalizedQuery)expand(row.item.id);else{const child=rows[index+1];if(child?.depth>row.depth)focus(child.path);}}
    else if(event.key==='ArrowLeft'){event.preventDefault();if(expanded.has(row.item.id)&&!normalizedQuery)setExpanded(value=>{const next=new Set(value);next.delete(row.item.id);return next;});else if(row.parentPath)focus(row.parentPath);}
    else if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle(row.item.id);}
  };
  const create=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(creating)return;
    const form=event.currentTarget,name=String(new FormData(form).get('name')||'').trim();if(!name)return;
    setCreating(true);setError('');
    try{
      const made=await options.onCreate?.(createParent??null,name,kindOf.id);
      if(made){
        setItems(current=>{
          const next=current.filter(item=>item.id!==made.id).map(item=>item.id===createParent?{...item,children:[...new Set([...(item.children||[]),made.id])]}:item);
          next.push({...made,children:[...(made.children||[])]});return next;
        });
        if(createParent===null)setRoots(current=>[...new Set([...current,made.id])]);
        if(createParent)setExpanded(current=>new Set(current).add(createParent));
      }
      await reload();
      setCreateParent(undefined);
    }catch(reason){setError(errorWords(reason));}
    finally{setCreating(false);}
  };
  const rename=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(mutating||!renaming)return;
    const name=String(new FormData(event.currentTarget).get('name')||'').trim();if(!name)return;
    setMutating(true);setError('');
    try{const changed=await options.onRename?.(renaming,name);if(changed)setItems(current=>current.map(item=>item.id===renaming?{...item,...changed}:item));await reload();setRenaming(null);}
    catch(reason){setError(errorWords(reason));}
    finally{setMutating(false);}
  };
  const edit=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();if(mutating||!editing)return;
    const form=new FormData(event.currentTarget),name=String(form.get('name')||'').trim(),description=String(form.get('description')||'').trim(),icon=String(form.get('icon')||'').trim();if(!name)return;
    setMutating(true);setError('');
    try{const changed=await options.onEdit?.(editing,{name,description,icon});if(changed)setItems(current=>current.map(item=>item.id===editing?{...item,...changed}:item));await reload();setEditing(null);}
    catch(reason){setError(errorWords(reason));}
    finally{setMutating(false);}
  };
  const descendants=React.useCallback((id:string)=>{const found=new Set<string>(),pending=[id];while(pending.length){const current=pending.pop()!;for(const child of itemMap.get(current)?.children||[])if(!found.has(child)){found.add(child);pending.push(child);}}return found;},[itemMap]);
  const move=async(parentId:string|null)=>{
    if(mutating||!moving||parentId===moving||parentId&&descendants(moving).has(parentId))return;
    const id=moving;setMutating(true);setError('');
    try{await options.onMove?.(id,parentId);if(!options.reload){setItems(current=>current.map(item=>({...item,children:(item.children||[]).filter(child=>child!==id)})).map(item=>item.id===parentId?{...item,children:[...(item.children||[]),id]}:item));setRoots(current=>parentId?current.filter(root=>root!==id):[...new Set([...current,id])]);}await reload();setMoving(null);}
    catch(reason){setError(errorWords(reason));}
    finally{setMutating(false);}
  };
  const link=async(parentId:string)=>{
    if(mutating||!linking||parentId===linking||descendants(linking).has(parentId))return;
    if(itemMap.get(parentId)?.children?.includes(linking))return;
    const id=linking;setMutating(true);setError('');
    try{
      await options.onLink?.(id,parentId);
      if(!options.reload)setItems(current=>current.map(item=>item.id===parentId?{...item,children:[...new Set([...(item.children||[]),id])]}:item));
      await reload();setLinking(null);
    }catch(reason){setError(errorWords(reason));}
    finally{setMutating(false);}
  };
  const remove=async(id:string)=>{
    if(mutating)return;setMutating(true);setError('');
    try{await options.onDelete?.(id);if(!options.reload){setItems(current=>current.filter(item=>item.id!==id).map(item=>({...item,children:(item.children||[]).filter(child=>child!==id)})));setRoots(current=>current.filter(root=>root!==id));setSelected(current=>{const next=new Set(current);next.delete(id);return next;});}await reload();setRemoving(null);}
    catch(reason){setError(errorWords(reason));}
    finally{setMutating(false);}
  };
  // Where each row sits: the row holding it (null at the top), and the rows beside it in their order.
  const parentOf=React.useMemo(()=>{const found=new Map<string,string>();for(const item of items)for(const child of item.children||[])if(!found.has(child))found.set(child,item.id);return found;},[items]);
  const siblingsOf=(id:string)=>{const parent=parentOf.get(id)??null;return {parent,ids:parent?(itemMap.get(parent)?.children||[]).filter(child=>itemMap.has(child)):rootIds};};
  const holdsRows=(item:ProjectTreeItem|undefined)=>Boolean(item&&!item.leaf);
  const reorder=async(id:string,parentId:string|null,beforeId:string|null)=>{
    if(mutating||!options.onReorder||id===beforeId||parentId===id||parentId&&descendants(id).has(parentId))return;
    setMutating(true);setError('');
    try{await options.onReorder(id,parentId,beforeId);await reload();if(parentId)setExpanded(current=>new Set(current).add(parentId));}
    catch(reason){setError(errorWords(reason));}
    finally{setMutating(false);}
  };
  const shift=(id:string,by:-1|1)=>{
    const {parent,ids}=siblingsOf(id),at=ids.indexOf(id);
    if(at<0||at+by<0||at+by>=ids.length)return;
    void reorder(id,parent,by<0?ids[at-1]!:ids[at+2]??null);
  };
  // Dropping on a row: its top half puts the dragged row before it; the rest puts it inside a row that holds rows,
  // or after a row that does not.
  const zoneOf=(event:React.DragEvent<HTMLElement>,item:ProjectTreeItem):'before'|'inside'|'after'=>{
    const box=event.currentTarget.getBoundingClientRect();
    return event.clientY<box.top+box.height/2?'before':holdsRows(item)?'inside':'after';
  };
  const drop=(target:ProjectTreeItem,zone:'before'|'inside'|'after')=>{
    const id=dragging;setDragging(null);setDropAt(null);if(!id||id===target.id)return;
    if(zone==='inside')return void reorder(id,target.id,null);
    const {parent,ids}=siblingsOf(target.id),at=ids.indexOf(target.id);
    void reorder(id,parent,zone==='before'?target.id:ids.slice(at+1).find(other=>other!==id)??null);
  };
  const kindOf=kinds.find(kind=>kind.id===createKind)??kinds[0]!;
  const creationForm=(depth=0)=>{
    const placeholder=createParent?kindOf.insidePlaceholder||kindOf.placeholder:kindOf.placeholder;
    return <form className="coss-project-tree-create" style={{'--tree-depth':depth} as React.CSSProperties} onSubmit={create}>
      <Input name="name" aria-label={placeholder} placeholder={placeholder} maxLength={160} autoFocus disabled={creating}/>
      <Button type="submit" size="sm" disabled={creating}>{words.add}</Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={words.cancelNew} onClick={()=>{setCreateParent(undefined);setError('');}}><X/></Button>
    </form>;
  };
  const withName=(template:string,name:string|undefined)=>{const [before,after='']=template.split('{name}');return <span>{before}<strong>{name}</strong>{after}</span>;};
  const detailsFor=(item:ProjectTreeItem)=>Boolean(options.onEdit&&!item.nameOnly);

  // One shared hover card per row, read from the app's DATA; nothing here names a project field.
  const withRowPreview=(row:VisibleRow,trigger:React.ReactElement<Record<string,unknown>>)=>{
    if(!rowPreview||moving||linking||row.item.manageable===false)return trigger;
    const params={id:row.item.id,name:row.item.name};
    const rename=detailsFor(row.item)?{id:'edit',label:words.editDetails,icon:'Pencil',onAction:()=>{setError('');setEditing(row.item.id);}}:options.onRename?{id:'rename',label:words.rename,icon:'Pencil',onAction:()=>{setError('');setRenaming(row.item.id);}}:null;
    const actions=[...rowPreview.actions.map(action=>{const filled=fillSurfaceAction(action,params);return {id:filled.id,label:filled.label,icon:filled.icon,onAction:()=>{runSurfaceAction(filled);}};}),...(rename?[rename]:[])];
    return <SurfacePreviewCard label={row.item.name} trigger={trigger} onOpen={()=>toggle(row.item.id)} glance={rowPreview.glance} glanceParams={params} description={row.item.description||rowPreview.description} actions={actions}/>;
  };

  return <section className="coss-project-tree" aria-label={options.label||'Projects'} data-tree-mode={options.selectionMode==='none'?'navigator':undefined}>
    <div className="coss-project-tree-tools">
      {options.searchable!==false&&<label className="coss-project-tree-search"><Search aria-hidden="true"/><Input type="search" value={query} onChange={event=>setQuery(event.target.value)} aria-label={options.searchLabel||'Find projects'} placeholder={options.searchLabel||'Find projects'}/></label>}
      {options.onCreate&&kinds.map(kind=><Button key={kind.id} type="button" variant="ghost" size="sm" onClick={()=>startCreate(null,kind.id)}>{kind.icon?<NamedIcon name={kind.icon} aria-hidden="true"/>:<Plus/>}<span className="coss-project-tree-new-label">{kind.label}</span></Button>)}
    </div>
    {moving&&<div className="coss-project-tree-mode" role="status">{withName(words.moveInto,itemMap.get(moving)?.name)}<Button type="button" variant="ghost" size="sm" disabled={mutating} onClick={()=>move(null)}>{words.topLevel}</Button><Button type="button" variant="ghost" size="icon-sm" aria-label={words.cancelMove} onClick={()=>setMoving(null)}><X/></Button></div>}
    {linking&&<div className="coss-project-tree-mode" role="status">{withName(words.linkInto,itemMap.get(linking)?.name)}<Button type="button" variant="ghost" size="icon-sm" aria-label={words.cancelLink} onClick={()=>setLinking(null)}><X/></Button></div>}
    {createParent===null&&creationForm(0)}
    <div ref={rowsBox} role="tree" aria-label={options.label||'Projects'} aria-multiselectable={options.selectionMode==='multiple'||options.selectionMode===undefined} className="coss-project-tree-rows" onMouseLeave={()=>setGlide(null)}>
      <AnimatePresence>{glide&&<motion.div aria-hidden="true" className="coss-project-tree-glide" initial={{opacity:0,top:glide.top,height:glide.height}} animate={{opacity:1,top:glide.top,height:glide.height}} exit={{opacity:0}} transition={reduced?INSTANT:GLIDE_SPRING}/>}</AnimatePresence>
      {!rows.length&&<p className="coss-project-tree-empty">{normalizedQuery?words.noMatch:options.emptyLabel||'No projects yet'}</p>}
      <AnimatePresence initial={false}>
      {rows.map(row=><motion.div key={row.path} role="none" className="coss-project-tree-item" initial={{height:0,opacity:0}} animate={{height:'auto',opacity:1}} exit={{height:0,opacity:0}} transition={reduced?INSTANT:ROW_SPRING}>
        <div role="treeitem" aria-level={row.depth+1} aria-expanded={row.hasChildren?(normalizedQuery?true:expanded.has(row.item.id)):undefined} aria-selected={selected.has(row.item.id)} tabIndex={active===row.path?0:-1} ref={node=>{if(node)rowRefs.current.set(row.path,node);else rowRefs.current.delete(row.path);}} data-tree-id={row.item.id} data-tree-path={row.path} data-drop={dropAt?.id===row.item.id?dropAt.zone:undefined} className="coss-project-tree-row" style={{'--tree-depth':row.depth} as React.CSSProperties} onFocus={event=>{setActive(row.path);glideTo(event.currentTarget);}} onMouseEnter={event=>glideTo(event.currentTarget)} onKeyDown={event=>handleKey(event,row)}
          draggable={Boolean(options.onReorder)&&row.item.manageable!==false&&!mutating}
          onDragStart={event=>{if(!options.onReorder)return;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',row.item.name);setDragging(row.item.id);}}
          onDragEnd={()=>{setDragging(null);setDropAt(null);}}
          onDragOver={event=>{if(!dragging||dragging===row.item.id||descendants(dragging).has(row.item.id))return;event.preventDefault();const zone=zoneOf(event,row.item);if(dropAt?.id!==row.item.id||dropAt.zone!==zone)setDropAt({id:row.item.id,zone});}}
          onDragLeave={()=>{if(dropAt?.id===row.item.id)setDropAt(null);}}
          onDrop={event=>{event.preventDefault();drop(row.item,zoneOf(event,row.item));}}>
          {row.depth>0&&<span className="coss-project-tree-guides" aria-hidden="true">{row.guides.map((guide,level)=><NestingGuide key={level} level={level} start={guide.start} end={guide.end}/>)}</span>}
          {row.hasChildren?<Button type="button" variant="ghost" size="icon-sm" className="coss-project-tree-disclosure" aria-label={(expanded.has(row.item.id)?'Collapse ':'Expand ')+row.item.name} onClick={()=>toggleExpanded(row.item.id)}><ChevronRight/></Button>:<span className="coss-project-tree-disclosure" aria-hidden="true"/>}
          {options.selectionMode!=='none'&&<Checkbox checked={selected.has(row.item.id)} disabled={row.item.selectable===false} aria-label={`Select ${row.item.name}`} onCheckedChange={()=>toggle(row.item.id)}/>}
          {withRowPreview(row,<Button type="button" variant="ghost" className="coss-project-tree-name" style={row.item.tone?{'--project-tree-glyph':`var(--notification-tone-${row.item.tone})`} as React.CSSProperties:undefined} disabled={mutating||row.item.selectable===false||Boolean(moving&&(moving===row.item.id||row.item.leaf||descendants(moving).has(row.item.id)))||Boolean(linking&&(linking===row.item.id||descendants(linking).has(row.item.id)||row.item.children?.includes(linking)))} onClick={()=>moving?move(row.item.id):linking?link(row.item.id):toggle(row.item.id)}>{row.item.thumbnail?<ProjectThumbnail src={row.item.thumbnail}/>:row.item.namedIcon?<NamedIcon name={row.item.namedIcon} aria-hidden="true"/>:row.item.icon?.trim()?<span className="coss-project-tree-icon" aria-hidden="true">{row.item.icon.trim()}</span>:row.item.kind==='project'?<span className="coss-project-tree-icon" aria-hidden="true">{Array.from(row.item.name.trim())[0]?.toLocaleUpperCase()||'?'}</span>:expanded.has(row.item.id)||normalizedQuery?<FolderOpen aria-hidden="true"/>:<Folder aria-hidden="true"/>}<span><strong>{row.item.name}</strong>{row.item.detail&&<small>{row.item.detail}</small>}</span>{row.item.recordKind&&<RecordKindMark kind={row.item.recordKind.kind} detail={row.item.recordKind.detail}/>}</Button>)}
          {row.item.manageable!==false&&(options.onCreate||options.onEdit||options.onRename||options.onMove||options.onLink||options.onDelete||options.onReorder)&&<ActionMenu label={`Actions for ${row.item.name}`} trigger={<Button type="button" variant="ghost" size="icon-sm" className="coss-project-tree-add"/>}
            items={[
              ...(options.onCreate&&holdsRows(row.item)?kinds.map(kind=>({id:`create:${kind.id}`,label:kind.inside,icon:kind.icon?kind.icon:Plus,group:'make'})):[]),
              ...(detailsFor(row.item)?[{id:'edit',label:words.editDetails,icon:Pencil,group:'change'}]:options.onRename?[{id:'rename',label:words.rename,icon:Pencil,group:'change'}]:[]),
              ...(options.onReorder?[{id:'up',label:words.moveUp,icon:'ArrowUp',group:'order'},{id:'down',label:words.moveDown,icon:'ArrowDown',group:'order'}]:[]),
              ...(options.onMove?[{id:'move',label:words.move,icon:FolderInput,group:'change'}]:[]),
              ...(options.onLink?[{id:'link',label:words.linkElsewhere,icon:FolderPlus,group:'change'}]:[]),
              ...(options.onDelete?[{id:'remove',label:words.remove,icon:Trash2,group:'remove',tone:'destructive'}]:[]),
            ]}
            onAction={id=>{setError('');if(id.startsWith('create:'))startCreate(row.item.id,id.slice('create:'.length));else if(id==='edit')setEditing(row.item.id);else if(id==='rename')setRenaming(row.item.id);else if(id==='up')shift(row.item.id,-1);else if(id==='down')shift(row.item.id,1);else if(id==='move')setMoving(row.item.id);else if(id==='link')setLinking(row.item.id);else if(id==='remove')setRemoving(row.item.id);}}/>}
        </div>
        {createParent===row.item.id&&creationForm(row.depth+1)}
        {renaming===row.item.id&&<form className="coss-project-tree-create" style={{'--tree-depth':row.depth+1} as React.CSSProperties} onSubmit={rename}><Input name="name" aria-label={`New name for ${row.item.name}`} defaultValue={row.item.name} maxLength={160} autoFocus disabled={mutating}/><Button type="submit" size="sm" disabled={mutating}>{words.save}</Button><Button type="button" variant="ghost" size="icon-sm" aria-label={words.cancelRename} onClick={()=>setRenaming(null)}><X/></Button></form>}
        {editing===row.item.id&&<form className="coss-project-tree-details" style={{'--tree-depth':row.depth+1} as React.CSSProperties} onSubmit={edit}><label>{words.detailsName}<Input name="name" aria-label={`${words.detailsName}: ${row.item.name}`} defaultValue={row.item.name} maxLength={160} autoFocus disabled={mutating}/></label>{options.detailsIcon!==false&&<label>{words.detailsIcon}<Input name="icon" aria-label={`${words.detailsIcon}: ${row.item.name}`} defaultValue={row.item.icon||''} maxLength={12} placeholder={Array.from(row.item.name.trim())[0]?.toLocaleUpperCase()||'P'} disabled={mutating}/></label>}<label>{words.detailsDescription}<Textarea name="description" aria-label={`${words.detailsDescription} ${row.item.name}`} defaultValue={row.item.description||''} maxLength={2000} placeholder={words.detailsDescriptionPlaceholder} disabled={mutating}/></label><div><Button type="submit" size="sm" disabled={mutating}>{words.saveDetails}</Button><Button type="button" variant="ghost" size="sm" onClick={()=>setEditing(null)}>{words.cancel}</Button></div></form>}
        {removing===row.item.id&&<div className="coss-project-tree-confirm" style={{'--tree-depth':row.depth+1} as React.CSSProperties}><span>{named(words.removeConfirm,row.item.name)}</span><Button type="button" variant="destructive" size="sm" disabled={mutating} onClick={()=>remove(row.item.id)}>{words.removeButton}</Button><Button type="button" variant="ghost" size="icon-sm" aria-label={words.cancelRemove} onClick={()=>setRemoving(null)}><X/></Button></div>}
      </motion.div>)}
      </AnimatePresence>
    </div>
    {error&&<p role="alert" className="coss-project-tree-error">{error}</p>}
  </section>;
}

export function mountProjectTree(node:HTMLElement,options:ProjectTreeOptions){
  node.classList.add('coss-ui');node.dataset.sharedRoot='true';
  const root=createRoot(node),control:TreeSelectionControl={};let chosen=[...(options.selected||[])];
  flushSync(()=>root.render(<ProjectTree options={options} control={control} onSelected={ids=>{chosen=ids;}}/>));
  return {selected:()=>[...chosen],setSelected:(ids:string[])=>flushSync(()=>control.setSelected?.(ids)),refresh:()=>control.refresh?.()??Promise.resolve(),destroy:()=>root.unmount()};
}

// A recording poster identifies a project at a glance; a poster that cannot load falls back to the project mark.
function ProjectThumbnail({src}:{src:string}){
  const [failed,setFailed]=React.useState(false);
  return failed?<Clapperboard aria-hidden="true"/>:<img className="coss-project-tree-thumb" src={src} alt="" aria-hidden="true" loading="lazy" decoding="async" onError={()=>setFailed(true)}/>;
}

function ProjectTreePicker({options}:{options:ProjectTreeOptions}){
  const [open,setOpen]=React.useState(false),[selected,setSelected]=React.useState(options.selected||[]),[items,setItems]=React.useState(options.items),[roots,setRoots]=React.useState(options.roots);const host=React.useRef<HTMLDivElement>(null);
  React.useEffect(()=>{if(!open)return;const close=(event:MouseEvent)=>{if(!host.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
  const names=new Map(items.map(item=>[item.id,item.name])),label=selected.length?selected.map(id=>names.get(id)).filter(Boolean).join(', '):options.placeholder||'All projects';
  const reload=options.reload?async()=>{const snapshot=await options.reload!();setItems(snapshot.items);if(snapshot.roots)setRoots(snapshot.roots);return snapshot;}:undefined;
  return <div className="coss-project-tree-picker" ref={host}><Button type="button" variant="outline" aria-haspopup="tree" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>{label}</Button>{open&&<div className="coss-project-tree-popover"><ProjectTree options={{...options,items,roots,reload,selected,onSelectionChange:ids=>{setSelected(ids);options.onSelectionChange?.(ids);if(options.selectionMode==='single'&&options.closeOnSelect!==false)setOpen(false);}}} onSelected={()=>{}}/></div>}</div>;
}

export function mountProjectTreePicker(node:HTMLElement,options:ProjectTreeOptions){
  node.classList.add('coss-ui');node.dataset.sharedRoot='true';const root=createRoot(node);flushSync(()=>root.render(<ProjectTreePicker options={options}/>));return {destroy:()=>root.unmount()};
}

// Drawn inside MotionFeatures (ui/motion/lazy-motion.tsx): its motion arrives after the first paint, without remounting.
export function ProjectTree(props: React.ComponentProps<typeof ProjectTreeMoving>) {
  return <MotionFeatures><ProjectTreeMoving {...props} /></MotionFeatures>;
}
