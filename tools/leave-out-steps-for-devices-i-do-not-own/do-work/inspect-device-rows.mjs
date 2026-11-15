import { deviceOfRow, namesDevice, factsShowDevice } from '../read-data/device-rows.mjs';
// Evidence reads that failed never stand for proof that the person owns no device.
export async function inspectDeviceRows(input = {}, { door } = {}) {
 const rules=input.rules ?? await door.read('record:content-setting','record:content-setting:waiting-on-you-devices');
 if(!Array.isArray(input.rows))throw new Error('Supply the waiting rows to inspect.');
 const shown=[],hidden=[];
 for(const row of input.rows){
  const model=deviceOfRow(row.id,row.values,rules);
  const found=factsShowDevice(input.reports,model)||(input.file_names??[]).some(name=>namesDevice(name,model));
  // Only an explicitly complete, successful observation can hide anything.
  (model && !found && input.evidence_complete===true ? hidden : shown).push(row);
 }
 return {shown,hidden};
}
