import { publishReviewedArticle } from '../../write-a-sales-page/packages/hosted-public-app/processes/publish-reviewed-article.mjs';
import { captureArticleCandidate, readRenderArtifact, releaseRenderWorkspace } from './render-article-candidate.mjs';
import { sendRequestToRunningApp } from '../../send-requests-to-an-engine/read-data/find-the-running-app-and-send-requests-to-it.mjs';
import { prepareCurrentDocument } from '../../publish-content-for-discovery/do-work/prepare-current-document.mjs';

const CONFIG = {address:'package::public-document-site::publication-config::default',mode:'label_hash'};

export function requireAcceptedReview(result) {
  if (result?.accepted !== true || (Object.hasOwn(result,'findings') && (!Array.isArray(result.findings) || result.findings.some(finding => finding?.resolved !== true)))) {
    throw new Error('The rendered page did not pass its required design review.');
  }
  return result;
}

/** Native publication owner. The session is the selected running-app transport,
 * not user-authored content. Every candidate, policy, screenshot and verdict is
 * obtained here; requests cannot provide a page or an approval. */
export async function publishCurrentDocument(input, {session, expectedDocumentRevision = null}) {
  if (!input || Object.keys(input).some(key => key !== 'document_ref') ||
      !/^package::documents::documents::[^\s]+$/.test(input.document_ref ?? '')) {
    throw new Error('Only a Documents reference can be published.');
  }
  const send = (target,payload,timeoutMs=90000) => sendRequestToRunningApp(session,target,payload,{timeoutMs});
  async function read(ref) {
    if (!ref?.address || !['label_hash','identity_text'].includes(ref.mode)) throw new Error('Invalid current record reference.');
    const row = await send('engine.operation.label-addressed',{
      operation_label:'engine.operation.read-current',address_label:ref.address,address_mode:ref.mode,
    },20000);
    if (row?.found !== true || !row.content_hash || !row.payload) throw new Error(`Current publication record unavailable: ${ref.address}`);
    return row;
  }
  const configRow = await read(CONFIG);
  const config = configRow.payload;
  if (config.kind !== 'public-document-publication-config' || !config.provider_application || !config.design_policy_ref) {
    throw new Error('Current publication settings must name the provider application and design policy.');
  }
  const designRow = await read(config.design_policy_ref);
  const design = designRow.payload;
  if (!design.rubric || !Array.isArray(design.providers) || !config.evidence_namespace) {
    throw new Error('Current design review must declare its rubric, providers and evidence storage.');
  }
  let reviewedCandidate;
  let renderedEvidence;
  const deployment = await publishReviewedArticle({session,send,document_ref:input.document_ref},{
    currentProviderApplication: async () => config.provider_application,
    prepareCurrentDocument: async () => {
      const candidate = await prepareCurrentDocument(input, null, { send: ({ target, payload }) => send(target, payload) });
      if (candidate?.state !== 'render-review-required') throw new Error('The Documents owner returned no reviewed candidate.');
      if (expectedDocumentRevision !== null && candidate.document_revision_hash !== expectedDocumentRevision) {
        throw new Error('The document changed after the publication request was admitted.');
      }
      if (candidate.input_bases?.find(base=>base.ref.address===CONFIG.address)?.content_hash !== configRow.content_hash) {
        throw new Error('Publication settings changed before preparation.');
      }
      candidate.input_bases.push({ref:config.design_policy_ref,content_hash:designRow.content_hash});
      for (const role of ['factual','writing']) {
        const reviews = candidate.verdicts?.filter(review => review.role === role) ?? [];
        if (reviews.length !== 1) throw new Error(`Missing distinct ${role} review.`);
        requireAcceptedReview(reviews[0].verdict);
      }
      reviewedCandidate = candidate;
      return candidate;
    },
    inputBasesAreCurrent: async ({input_bases}) => {
      for (const base of input_bases) if ((await read(base.ref)).content_hash !== base.content_hash) return false;
      return true;
    },
    reviewRenderedCandidate: async args => {
      const capture = await captureArticleCandidate(args);
      try {
        const parts = [];
        for (const viewport of ['desktop','mobile']) {
          const bytes = await readRenderArtifact(capture.workspace_handle,`${viewport}.jpg`);
          const stored = await send('cas-store.materialize-bytes',{
            bytes:[...bytes],metadata:{media_type:'image/jpeg',display_name:`Article ${viewport} preview`},
            namespace:config.evidence_namespace,
          });
          if (stored?.payload_address_mode !== 'address_bytes' || !stored.integrity_hash) throw new Error('Screenshot storage did not return an exact image reference.');
          parts.push({kind:'addressed-content',address:stored.payload_address,content_kind:'vision',
            mount_path:`${viewport}.jpg`,source:{kind:'blob_ref',hash:stored.integrity_hash},mime_type:'image/jpeg',
            byte_length:stored.byte_length,integrity_hash:stored.integrity_hash,delivery:{kind:'inline-base64'}});
        }
        const viewportVerdicts = [];
        for (const part of parts) {
          const viewportVerdict = await send('ask-a-small-model-for-a-verdict.judge-content',{
            rubric:design.rubric,providers:design.providers,passes:design.passes ?? 1,
            content:JSON.stringify({title:args.candidate.page.title,route:args.candidate.route_path,viewport:part.mount_path}),content_parts:[part],
          },180000);
          try {
            viewportVerdicts.push(requireAcceptedReview(viewportVerdict));
          } catch (error) {
            const rejectedReview = await send('cas-store.materialize-bytes',{
              bytes:[...Buffer.from(JSON.stringify({kind:'rejected-document-design-review',
                document_ref:input.document_ref,document_revision_hash:args.candidate.document_revision_hash,
                route:args.candidate.route_path,image:part,identities:capture.identities,verdict:viewportVerdict}))],
              metadata:{media_type:'application/json',display_name:'Article design review'},namespace:config.evidence_namespace,
            });
            throw new Error(`${error.message} Viewport: ${part.mount_path}; review: ${rejectedReview.payload_address}`);
          }
        }
        const verdict = {accepted:true,viewport_verdicts:viewportVerdicts};
        renderedEvidence = {images:parts,identities:capture.identities,verdict};
        return {...capture,status:'passed',verdicts:[
          ...args.candidate.verdicts.map(review => ({kind:review.role,status:'passed',verdict:review.verdict})),
          {kind:'design',status:'passed',verdict},
        ]};
      } finally {
        await releaseRenderWorkspace(capture.workspace_handle);
      }
    },
  });
  if (deployment.article_readback?.verified !== true) throw new Error('The published article was not read back.');
  const remoteUrl = new URL(reviewedCandidate.route_path,deployment.share_url).href;
  const served = await fetch(remoteUrl,{signal:AbortSignal.timeout(20000)});
  const html = await served.text();
  if (served.status !== 200 || !html.includes(reviewedCandidate.page.title)) {
    throw new Error('The published article URL did not return the reviewed title.');
  }
  const reviewRecord = await send('cas-store.materialize-bytes',{
    bytes:[...Buffer.from(JSON.stringify({kind:'reviewed-document-publication',document_ref:input.document_ref,
      document_revision_hash:reviewedCandidate.document_revision_hash,input_bases:reviewedCandidate.input_bases,
      content_verdicts:reviewedCandidate.verdicts,rendered_review:renderedEvidence,
      published:deployment.article_readback,url:remoteUrl}))],
    metadata:{media_type:'application/json',display_name:'Article publication review'},namespace:config.evidence_namespace,
  });
  if (!reviewRecord?.payload_address) throw new Error('The publication review could not be saved.');
  return {state:'published',document_ref:input.document_ref,
    document_revision_hash:reviewedCandidate.document_revision_hash,
    route_path:reviewedCandidate.route_path,review:renderedEvidence,deployment,
    remote:{provider_ref:'provider:fly',provider_receipt_ref:reviewRecord.payload_address,remote_object_id:reviewedCandidate.page_ref,
      remote_url:remoteUrl,publication_readback_ref:deployment.article_readback.image+'#'+reviewedCandidate.route_path,
      publication_readback_verified:true}};
}
