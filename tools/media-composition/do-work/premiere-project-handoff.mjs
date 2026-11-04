import path from 'node:path';

const literal = value => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function file(value, extension) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value) || extension && !value.toLowerCase().endsWith(extension)) throw new Error('Use a resolved absolute file path.');
  return path.normalize(value);
}

/** Pure command builder for the installed MCPBridgeCEP evalScript contract.
 * No process activation, command-file submission, or personal project mutation.
 * The caller must establish a responsive bridge and own submission/recovery.
 */
export function buildPremiereProjectHandoff({id, xmlPath, outputPath, title, fps, cuts}) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Use a unique request identifier.');
  xmlPath = file(xmlPath, '.xml'); outputPath = file(outputPath, '.prproj');
  if (typeof title !== 'string' || !title.trim() || !Number.isFinite(fps) || fps < 1 || fps > 120 || !Array.isArray(cuts) || !cuts.length || cuts.length > 10000) throw new Error('Provide the sequence name, frame rate and source cuts.');
  cuts = cuts.map(cut => {
    if (!Number.isFinite(cut.in) || !Number.isFinite(cut.out) || cut.in < 0 || cut.out <= cut.in) throw new Error('Use valid forward source cuts.');
    return {source: file(cut.source), in: cut.in, out: cut.out};
  });
  const input = {id, xmlPath, outputPath, title, fps, cuts};
  const script = `(function(){
var p=${literal(input)};
function fail(message){throw new Error(message);}
function same(a,b){return new File(a).fsName===new File(b).fsName;}
function near(a,b){return isFinite(a)&&Math.abs(a-b)<=1/p.fps+0.000001;}
if(new File(p.outputPath).exists)fail('The destination already exists. Choose a new project file.');
if(!new File(p.xmlPath).exists)fail('The timeline XML is unavailable.');
for(var i=0;i<p.cuts.length;i++)if(!new File(p.cuts[i].source).exists)fail('A source file is unavailable.');
// Never close or replace a customer project, including an unsaved one.
if(app.isDocumentOpen())fail('Close the current Premiere project before creating this isolated project.');
if(!app.newProject(p.outputPath))fail('Premiere could not create the project.');
if(!same(app.project.path,p.outputPath))fail('Premiere opened a different project.');
if(!app.project.importFiles([p.xmlPath],true,app.project.rootItem,false))fail('Premiere could not import the timeline.');
var matches=[];
for(i=0;i<app.project.sequences.numSequences;i++){var candidate=app.project.sequences[i];if(candidate.name===p.title)matches.push(candidate);}
if(matches.length!==1)fail('The imported sequence could not be identified uniquely.');
var seq=matches[0], clips=[];
for(var t=0;t<seq.videoTracks.numTracks;t++)for(i=0;i<seq.videoTracks[t].clips.numItems;i++)clips.push(seq.videoTracks[t].clips[i]);
clips.sort(function(a,b){return a.start.seconds-b.start.seconds;});
if(clips.length!==p.cuts.length)fail('Premiere imported a different number of source cuts.');
var elapsed=0, observed=[];
for(i=0;i<clips.length;i++){
var c=clips[i], wanted=p.cuts[i];
if(!c.projectItem||!same(c.projectItem.getMediaPath(),wanted.source)||!near(c.inPoint.seconds,wanted.in)||!near(c.outPoint.seconds,wanted.out)||!near(c.start.seconds,elapsed)||!near(c.end.seconds,elapsed+wanted.out-wanted.in))fail('An imported source cut does not match the requested edit.');
observed.push({source:c.projectItem.getMediaPath(),in:c.inPoint.seconds,out:c.outPoint.seconds,start:c.start.seconds,end:c.end.seconds});
elapsed+=wanted.out-wanted.in;
}
if(!same(app.project.path,p.outputPath))fail('The active project changed before saving.');
if(app.project.save()!==0)fail('Premiere could not save the imported edit.');
var saved=new File(p.outputPath);
if(!saved.exists||saved.length<=0)fail('Premiere did not save a project file.');
return JSON.stringify({request_id:p.id,project_path:saved.fsName,sequence_name:seq.name,sequence_id:seq.sequenceID,source_cuts:observed,saved:true,verification:'native-source-cuts-before-save',effects_verified:false});
})();`;
  return {id, script, expected: input, support: {native_execution_verified: false, requires: ['responsive-existing-MCPBridgeCEP', 'no-open-Premiere-project', 'new-output-path', 'all-sources-online'], limitations: ['Caller must read back the saved project and verify reopening separately.', 'Source cuts only; XMEML effects and audio limitations remain.', 'No automatic retry after ambiguous bridge timeout: inspect the new project first.']}};
}
