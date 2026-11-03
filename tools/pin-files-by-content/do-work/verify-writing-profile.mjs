#!/usr/bin/env node
// tools/pin-files-by-content/do-work/verify-writing-profile.mjs
//
// Caller-owned writing DATA and evidence checks. Never a semantic or voice judge.
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hashBuffers, verifySourceSpans} from './verify-source-spans.mjs';

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const digest = bytes => hashBuffers([bytes])[0];
const decode = bytes => new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);
export const normalizeWriting = s => s.normalize('NFKC').replace(/[\u00ad\u200b\ufeff]/gu, '').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
export const writingBlocks = text => [...text.matchAll(/\S[\s\S]*?(?=\r?\n[^\S\r\n]*\r?\n|(?![\s\S]))/gu)].map(m => ({text:m[0].trim(), byte_start:Buffer.byteLength(text.slice(0,m.index))}));

// Match the downstream Markdown reader's supported inline code/emphasis delimiters.
// Keep code contents literal; unwrap formatting and escaped punctuation as its
// renderer does. This is deliberately a small projection, not a Markdown parser.
const inlineToken=/(?<!\\)(`[^`\n]+`|\*\*(?=\S).+?(?<=\S)\*\*|(?<!\w)__(?=\S).+?(?<=\S)__(?!\w)|(?<!\*)\*(?=\S)[^*\n]+?(?<=\S)\*(?!\*)|(?<![\w_])_(?=\S)[^_\n]+?(?<=\S)_(?![\w_]))/gu;
const plainInline=value=>{
 let out='',cursor=0;
 for(const m of value.matchAll(inlineToken)){
  out+=value.slice(cursor,m.index).replace(/\\([*_`])/gu,'$1');
  const marker=m[0];
  out+=marker.startsWith('`')?marker.slice(1,-1):plainInline(marker.startsWith('**')||marker.startsWith('__')?marker.slice(2,-2):marker.slice(1,-1));
  cursor=m.index+marker.length;
 }
 return out+value.slice(cursor).replace(/\\([*_`])/gu,'$1');
};
const visibleWriting=text=>text.replace(/<!--[\s\S]*?-->/gu,'').split(/\r?\n/gu).map(plainInline).join('\n');

// Literal ATX headings in the downstream reader's supported Markdown subset.
// The caller supplies the required sequence; no document-specific names live here.
const sourceHeading=line=>{
 const match=/^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line.trim());
 return match?`${match[1]} ${match[2].trim()}`:null;
};

export function verifyWritingProfile(documentBytes, profile, reviews = null) {
  const invalid = (kind, detail = {}) => ({schema:'writing-profile-readback-v1', status:'invalid', findings:[{kind, ...detail}], assurance:'No semantic, factual, speaker or author-voice assurance.'});
  let text;
  try {text=decode(documentBytes);} catch {return invalid('document_invalid_utf8');}
  if (!text.trim() || !record(profile) || profile.schema!=='writing-profile-v1' || profile.document_role!=='current_prose'
      || !Array.isArray(profile.rejections) || !profile.rejections.length || !Array.isArray(profile.protected_literals)
      || !Array.isArray(profile.superseded_terms) || !Array.isArray(profile.required_components)) return invalid('invalid_profile');
  const explicitComponentCoverage=profile.component_coverage_mode==='explicit_disposition_v1';
  if (Object.hasOwn(profile,'component_coverage_mode') && !explicitComponentCoverage) return invalid('invalid_component_coverage_mode');
  const componentCoverageIds=profile.component_coverage_components??[];
  if (!Array.isArray(componentCoverageIds) || new Set(componentCoverageIds).size!==componentCoverageIds.length
      || componentCoverageIds.some(id=>!nonempty(id)||!profile.required_components.includes(id))
      || (explicitComponentCoverage && componentCoverageIds.length===0)
      || (!explicitComponentCoverage && componentCoverageIds.length!==0)) return invalid('invalid_component_coverage_components');
  const componentRequirements=profile.component_requirements??[];
  if (!Array.isArray(componentRequirements)
      || (explicitComponentCoverage && componentRequirements.length!==componentCoverageIds.length)) return invalid('invalid_component_requirements');
  const requirementIds=new Set();
  for (const requirement of componentRequirements) {
    if (!record(requirement) || !nonempty(requirement.id) || requirementIds.has(requirement.id)
        || !componentCoverageIds.includes(requirement.id) || !nonempty(requirement.source_mechanism)
        || !nonempty(requirement.destination_criterion)) return invalid('invalid_component_requirements');
    requirementIds.add(requirement.id);
  }
  if (explicitComponentCoverage && (requirementIds.size!==componentCoverageIds.length
      || componentCoverageIds.some(id=>!requirementIds.has(id)))) return invalid('invalid_component_requirements');
  const rules=[...profile.rejections,...profile.superseded_terms];
  // A rule row is judged field by field so a refusal names the list, the position and the field (never the text).
  // `authority` is the person's own provenance label for the rule; any non-empty label is a valid row.
  const ruleFault=(r,ids)=>{
    if (!record(r)) return 'row';
    if (!nonempty(r.id) || ids.has(r.id)) return 'id';
    if (!nonempty(r.text) || normalizeWriting(r.text).length<8 || (r.scope==='heading' && /[\r\n]/u.test(r.text))) return 'text';
    if (!nonempty(r.authority)) return 'authority';
    if (r.scope!==undefined && !['document','heading'].includes(r.scope)) return 'scope';
    return null;
  };
  const ids=new Set();
  for (const [rule_index,r] of rules.entries()) {
    const field=ruleFault(r,ids);
    if (field) { const inRejections=rule_index<profile.rejections.length; return invalid('invalid_rule',{list:inRejections?'rejections':'superseded_terms', rule_index:inRejections?rule_index:rule_index-profile.rejections.length, field}); }
    ids.add(r.id);
  }
  if (profile.protected_literals.some(x=>!nonempty(x)) || profile.required_components.some(x=>!nonempty(x))
      || new Set(profile.required_components).size!==profile.required_components.length) return invalid('invalid_component_or_literal');
  const sectionOrder=profile.required_section_order??[];
  if ((Object.hasOwn(profile,'required_section_order') && profile.required_section_order===null)
      || !Array.isArray(sectionOrder) || sectionOrder.some(x=>!nonempty(x)||/[\r\n]/u.test(x)||sourceHeading(x)!==x)
      || new Set(sectionOrder).size!==sectionOrder.length) return invalid('invalid_required_section_order');
  const originals=profile.original_sources??[];
  if (!Array.isArray(originals)) return invalid('invalid_original_source_allowlist',{field:'list'});
  // `authority` on an allowlist row is the person's provenance label; the gate is the review row: its
  // `source_authority` must be one of the three author labels and match the allowlist row for that source.
  const seenSources=new Set();
  for (const [source_index,x] of originals.entries()) {
    const field=!record(x)?'row':!/^[a-f0-9]{64}$/.test(x.blake3??'')||seenSources.has(x.blake3)?'blake3':!nonempty(x.authority)?'authority':null;
    if (field) return invalid('invalid_original_source_allowlist',{source_index,field});
    seenSources.add(x.blake3);
  }
  const findings=[];
  const blocks=writingBlocks(text), normalized=normalizeWriting(text), rendered=normalizeWriting(visibleWriting(text));
  const hashes=hashBuffers([documentBytes,...(reviews===null?[]:blocks.map(block=>Buffer.from(block.text)))]);
  const document_blake3=hashes[0], blockDigests=hashes.slice(1);
  const headings=text.replace(/\r\n?/gu,'\n').split('\n').map(sourceHeading);
  let previousSection=-1;
  for (const [section_index,heading] of sectionOrder.entries()) {
    const positions=headings.flatMap((value,index)=>value===heading?[index]:[]);
    if (positions.length!==1) findings.push({kind:'required_section_missing_or_repeated',section_index});
    else {
      if (positions[0]<=previousSection) findings.push({kind:'required_section_order_mismatch',section_index});
      previousSection=positions[0];
    }
  }
  // The downstream reader uses splitlines and does not hide comment-wrapped
  // ATX lines. Check that raw projection as well as visible inline formatting.
  const visibleHeadings=[text,visibleWriting(text)].flatMap(value=>value.replace(/\r\n?/gu,'\n').split('\n').map(plainInline).map(sourceHeading).filter(Boolean).map(normalizeWriting));
  for (const [rule_index,r] of rules.entries()) {
    const rejected=normalizeWriting(r.text);
    const matches=r.scope==='heading'
      ? visibleHeadings.includes(rejected)
      : [' '+normalized+' ',' '+rendered+' '].some(candidate=>candidate.includes(' '+rejected+' '));
    if(matches) findings.push({kind:rule_index<profile.rejections.length?'known_rejection':'superseded_current_term',rule_index});
  }
  const visible=visibleWriting(text);
  for (const [literal_index,s] of profile.protected_literals.entries()) if (!visible.includes(s)) findings.push({kind:'protected_literal_changed_or_missing',literal_index});
  const coverage=new Set(), components=new Set();
  let sourceEvidence=null;
  if (reviews!==null) {
    if (!record(reviews) || reviews.schema!=='writing-review-v1' || reviews.document_blake3!==document_blake3 || !Array.isArray(reviews.blocks)
        || !Array.isArray(reviews.components)) return invalid('invalid_or_stale_review_manifest');
    for (const row of reviews.blocks) {
      if (!record(row) || !Number.isSafeInteger(row.block_index) || row.block_index<0 || row.block_index>=blocks.length
          || coverage.has(row.block_index) || !['root','model','author'].includes(row.reviewer_role) || !nonempty(row.reviewer)
          || !nonempty(row.reason) || !['retain','revised_and_reviewed'].includes(row.decision)
          || row.block_blake3!==blockDigests[row.block_index]) return invalid('invalid_or_stale_block_review');
      coverage.add(row.block_index);
    }
    if (reviews.components.length) {
      sourceEvidence=verifySourceSpans(reviews.source_bindings);
      if (!sourceEvidence.passed) findings.push({kind:'component_literal_evidence_failed'});
      const quotes=reviews.source_bindings?.quotes??[], sources=reviews.source_bindings?.sources??[];
      for (const row of reviews.components) {
        if (!record(row) || !profile.required_components.includes(row.component_id) || components.has(row.component_id)
            || !Number.isSafeInteger(row.source_quote_index) || !Number.isSafeInteger(row.destination_quote_index)
            || row.source_quote_index<0 || row.destination_quote_index<0 || row.source_quote_index>=quotes.length || row.destination_quote_index>=quotes.length
            || row.source_quote_index===row.destination_quote_index || !['author_text','author_correction','author_declared_protocol'].includes(row.source_authority)
            || !nonempty(row.relationship_review) || !['root','model','author'].includes(row.reviewer_role)
            || (componentCoverageIds.includes(row.component_id) && !['represented','partial','not_represented'].includes(row.coverage_disposition))
            || (!componentCoverageIds.includes(row.component_id) && Object.hasOwn(row,'coverage_disposition'))) return invalid('invalid_component_review');
        const target=quotes[row.destination_quote_index], targetSource=sources.find(s=>s.id===target.source_id);
        if (!targetSource || targetSource.blake3!==document_blake3) return invalid('component_destination_not_current_document');
        const original=quotes[row.source_quote_index], originalSource=sources.find(s=>s.id===original.source_id);
        if (!originalSource || originalSource.id===targetSource.id || originalSource.path===targetSource.path || originalSource.blake3===document_blake3
            || !originals.some(x=>x.blake3===originalSource.blake3 && x.authority===row.source_authority)) return invalid('component_source_not_authorized_original');
        components.add(row.component_id);
        if (componentCoverageIds.includes(row.component_id) && row.coverage_disposition!=='represented') {
          findings.push({kind:'required_source_component_not_represented',component_index:profile.required_components.indexOf(row.component_id)});
        }
      }
    }
  }
  for (let block_index=0;block_index<blocks.length;block_index++) if (!coverage.has(block_index)) findings.push({kind:'unreviewed_current_block',block_index});
  for (const [component_index,id] of profile.required_components.entries()) if (!components.has(id)) findings.push({kind:'unreviewed_source_component',component_index});
  const hard=findings.some(x=>!['unreviewed_current_block','unreviewed_source_component'].includes(x.kind));
  return {schema:'writing-profile-readback-v1',status:hard?'known_failure':findings.length?'review_required':'checks_satisfied', document_blake3,
    blocks:blocks.length, current_block_reviews:coverage.size, required_source_components:profile.required_components.length,
    reviewed_source_components:components.size, explicitly_dispositioned_source_components:componentCoverageIds.length, findings,
    review_identity:'Caller assertions checked for valid roles and current bytes; identity/authorship is not authenticated here.',
    component_coverage_mode:explicitComponentCoverage?'explicit_disposition_v1':'legacy_review_assertion',
    component_assurance:sourceEvidence?'Source and destination literal bytes verified. Component criteria and disposition remain reviewer assertions; this check does not establish semantic equivalence.':'No source component evidence supplied.',
    assurance:'Known-rejection, protected-text and evidence-coverage checks only. Zero findings is not proof of semantic correctness, author voice, source completeness, author approval, publication readiness or a finished book.'};
}

function main() {
  const argv=process.argv.slice(2), arg=k=>argv.includes(k)?argv[argv.indexOf(k)+1]:null;
  if (!arg('--document')||!arg('--profile')||!arg('--out')) {console.error('usage: node tools/pin-files-by-content/do-work/verify-writing-profile.mjs --document prose.md --profile rules.json [--reviews reviews.json] --out new-report.json');return 2;}
  let result;
  try {
    const bytes=readFileSync(resolve(arg('--document'))), p=readFileSync(resolve(arg('--profile'))), r=arg('--reviews')?readFileSync(resolve(arg('--reviews'))):null;
    result=verifyWritingProfile(bytes,JSON.parse(decode(p)),r?JSON.parse(decode(r)):null);
    result.profile_blake3=digest(p);if(r)result.review_manifest_blake3=digest(r);
  } catch {console.error('Cannot read or verify writing inputs.');return 2;}
  try {writeFileSync(resolve(arg('--out')),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});}
  catch {console.error('Cannot create report; existing reports are never replaced.');return 2;}
  console.log(JSON.stringify({status:result.status,findings:result.findings.length}));
  return result.status==='checks_satisfied'?0:result.status==='invalid'?2:1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)process.exitCode=main();
