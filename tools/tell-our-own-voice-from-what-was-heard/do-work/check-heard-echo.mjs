import { createHeardEcho } from '../read-data/heard-echo.mjs';
// The notification owner's selector is a pure two-shape adapter: explicit channel ids,
// or every current channel except those the row excludes. No delivery owner is imported.
const kindChannels=(kind,channels)=>Array.isArray(kind.channels)?kind.channels
 :kind.channels?.every?channels.map(row=>row.id).filter(id=>!(kind.channels.except??[]).includes(id)):[];
export async function checkHeardEcho(input = {}, { door } = {}) {
 const data=input.settings ?? await door.read('record:content-setting','record:content-setting:heard-echo');
 const tellRows=input.notification_rows ?? await door.read('record:content-setting','record:content-setting:tell-the-person');
 if(!data?.spoken || !Array.isArray(tellRows?.channels) || !Array.isArray(tellRows?.kinds))throw new Error('Supply the echo and notification rows.');
 if(!Array.isArray(input.notices))throw new Error('Supply the notices this account actually kept.');
 const at=typeof input.at==='number'?input.at:Date.parse(input.at);
 if(!Number.isFinite(at))throw new Error('Supply the time these words were heard.');
 return {echo:createHeardEcho({data,tellRows,kindChannels}).echoOf(input.text,at,input.notices)};
}
