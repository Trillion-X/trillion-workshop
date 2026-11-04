export function validateTimedText(rows,duration){
 if(rows===undefined)return;
 if(!Array.isArray(rows)||rows.length>2000)throw Error('Choose a valid caption list.');
 const ids=new Set();for(const row of rows){if(!row||typeof row.id!=='string'||!row.id||ids.has(row.id)||typeof row.text!=='string'||row.text.length>2000||![row.start,row.end,row.x,row.y].every(Number.isFinite)||row.start<0||row.end<=row.start||row.end>duration+.05||row.x<0||row.x>1||row.y<0||row.y>1)throw Error('Check caption times, text and positions.');ids.add(row.id);}
 return rows.map(({id,text,start,end,x,y})=>({id,text,start,end,x,y}));
}
