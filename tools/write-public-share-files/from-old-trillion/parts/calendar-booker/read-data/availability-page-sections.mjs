// Public booking supplies DATA to the existing shared section/choice renderer.
// Amie: named host, duration, timezone, offered times and separate confirmation.
// 21st reference 34576: day strip followed by time choices; inspiration only.
const dayOf=(time,timezone)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
export function availabilityPageSections({code,offered,accessCode=null,verified=false,requestKey,move=null,afterMs=null}){
  const {link,slots}=offered;
  const suffix=accessCode?`?access_code=${encodeURIComponent(accessCode)}`:'';
  const root=`/share/${encodeURIComponent(code)}`,path=`${root}/book${suffix}`;
  if(afterMs!==null&&(!Number.isSafeInteger(afterMs)||afterMs<0))throw Object.assign(new Error('Choose a valid time page.'),{status:400});
  const currentSlots=afterMs===null?slots:slots.filter(slot=>slot.startMs>=afterMs);
  const shown=currentSlots.slice(0,48),groups=new Map();
  for(const slot of shown){const day=dayOf(slot.startMs,link.timezone);if(!groups.has(day))groups.set(day,[]);groups.get(day).push(slot);}
  const dayFormat=new Intl.DateTimeFormat('en-US',{timeZone:link.timezone,weekday:'long',month:'long',day:'numeric'});
  const timeFormat=new Intl.DateTimeFormat('en-US',{timeZone:link.timezone,hour:'numeric',minute:'2-digit',timeZoneName:'short'});
  const sections=[{emphasis:'share-featured',heading:link.title,heading_level:1,body:link.description??null,
    items:[{heading:`${link.duration_min} minutes`,body:link.location??'Meeting details arrive with your invitation'},{heading:'Time zone',body:link.timezone}]}];
  if(!verified){sections.push({emphasis:'share-entry',heading:'Where should we send your invitation?',heading_level:2,body:'Verify your email once to book and manage this meeting.',choices:{href:`${root}/prove`,values:{},fields:[{name:'email',label:'Email address',kind:'email',required:true,autocomplete:'email'}],submit:{label:'Verify email',tone:'primary'}}});return sections;}
  if(!shown.length){sections.push({emphasis:'share-entry',heading:'No times are available in this window',body:'Try a later day or check again after the host changes their availability.'});return sections;}
  sections.push({emphasis:'share-entry',heading:move?'Choose a new time':'Choose a time',heading_level:2,
    choices:{href:path,values:{action:move?'move':'reserve',request_key:requestKey,...(move?{reservation_id:move}:{})},
      groups:[{name:'start_ms',options:shown.map(slot=>({value:String(slot.startMs),label:timeFormat.format(new Date(slot.startMs)),detail:dayFormat.format(new Date(slot.startMs))+(slot.seats_left?` · ${slot.seats_left} ${slot.seats_left===1?'seat':'seats'} left`:'')}))}],
      fields:move?[]:[{name:'name',label:'Your name',kind:'text',autocomplete:'name',max_length:200}],submit:{label:move?'Move meeting':link.requires_confirmation?'Request meeting':'Book meeting',tone:'primary'}}});
  const days=[...groups];
  sections.splice(1,0,{emphasis:'share-entry',actions:days.map(([day,rows])=>({label:dayFormat.format(new Date(rows[0].startMs)),href:`${path}${suffix?'&':'?'}from=${day}${move?`&move=${encodeURIComponent(move)}`:''}`,tone:'quiet'}))});
  if(currentSlots.length>shown.length){const next=currentSlots[shown.length].startMs;sections.push({actions:[{label:'More available times',href:`${path}${suffix?'&':'?'}after_ms=${next}${move?`&move=${encodeURIComponent(move)}`:''}`,tone:'quiet'}]});}
  return sections;
}
