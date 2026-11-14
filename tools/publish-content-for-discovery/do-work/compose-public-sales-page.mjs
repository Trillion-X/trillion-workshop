const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clean = (value) => typeof value === 'string' ? value.trim() : '';

function slug(value) {
  return clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function routeSegment(routePath, routePrefix) {
  const prefix = `${routePrefix}/`;
  if (typeof routePath !== 'string' || !routePath.startsWith(prefix)) return null;
  const segment = routePath.slice(prefix.length);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment) ? segment : null;
}

function visitDocumentNodes(nodes, out = []) {
  for (const node of nodes) {
    if (!isRecord(node) || node.visible === false) continue;
    if (node.kind === 'Container') {
      visitDocumentNodes(Array.isArray(node.children) ? node.children : [], out);
      continue;
    }
    if (node.kind !== 'Text') throw new Error(`Documents node kind ${clean(node.kind) || '(missing)'} cannot be published as article text.`);
    const text = clean(node.props?.text);
    if (!text) continue;
    const heading = Number(node.props?.custom?.heading_level);
    const refs = Array.isArray(node.props?.custom?.source_refs)
      ? node.props.custom.source_refs.filter((ref) => typeof ref === 'string' && ref.trim()).map((ref) => ref.trim())
      : [];
    out.push({ text, heading_level: Number.isInteger(heading) && heading >= 1 && heading <= 6 ? heading : null, refs });
    visitDocumentNodes(Array.isArray(node.children) ? node.children : [], out);
  }
  return out;
}

function publicBlocks(paragraphs, sources, composition) {
  return paragraphs.map((paragraph) => paragraph.heading_level
    ? { kind: 'section-heading', text: paragraph.text }
    : { kind: 'paragraph', text: paragraph.text, ...(paragraph.refs.length ? {
      source_refs: paragraph.refs,
      ...(sources.length ? {parts:[{text:paragraph.text+' '},...paragraph.refs.map(ref=>{
        const index=sources.findIndex(source=>source.ref===ref), source=sources[index];
        if (!source) throw new Error(`Cited source is unresolved: ${ref}`);
        return {text:`[${index+1}]`,source_preview:{number:String(index+1),title:source.title,
          excerpt:source.excerpt ?? source.text,source_label:composition.source_label,
          ...source.media,membership_href:composition.membership_href,
          membership_label:composition.membership_label,member_library_href:composition.member_library_href}};
      })]} : {}),
    } : {}) });
}

function validateSharedComposition(composition) {
  if (!isRecord(composition) || composition.kind !== 'public-document-composition') {
    throw new Error('composition_ref must resolve a public-document-composition record.');
  }
  if (Object.hasOwn(composition, 'title') || Object.hasOwn(composition, 'blocks') || Object.hasOwn(composition, 'body')) {
    throw new Error('Shared composition cannot contain document title or authored body content.');
  }
  const required = ['brand_label', 'layout', 'route_prefix'];
  for (const field of required) if (!clean(composition[field])) throw new Error(`Composition is missing ${field}.`);
  if (!Array.isArray(composition.navigation)) throw new Error('Composition navigation must be an array.');
  if (!Array.isArray(composition.related_cards)) throw new Error('Composition related_cards must be an array.');
  if (composition.document_routes !== undefined && !isRecord(composition.document_routes)) {
    throw new Error('Composition document_routes must be an object keyed by document_ref.');
  }
}

/**
 * Formats one fresh Documents owner snapshot with shared site/funnel DATA.
 * The article's title and body always come from the current editable scene.
 * This returns a candidate row only; admission must happen at the trusted
 * publication owner after exact-revision review.
 */
export function composePublicSalesPageCandidate({ snapshot, composition, destination, sources = [] }) {
  if (!isRecord(snapshot) || !/^1f:[0-9a-f]{64}$/.test(clean(snapshot.document_revision_hash))) {
    throw new Error('A current Documents snapshot with its owner-computed revision is required.');
  }
  if (!clean(snapshot.document_ref).startsWith('package::documents::documents::')) {
    throw new Error('The source must be a canonical Documents record.');
  }
  if (!isRecord(snapshot.body) || !Array.isArray(snapshot.body.children)) {
    throw new Error('The current Documents scene is missing or malformed.');
  }
  validateSharedComposition(composition);
  if (!isRecord(destination) || destination.kind !== 'public-sales-page-destination') {
    throw new Error('destination_ref must resolve a public-sales-page-destination record.');
  }
  const recordSetAddress = clean(destination.record_set_address);
  const routePrefix = clean(destination.route_prefix || composition.route_prefix).replace(/\/+$/, '');
  const recordKind = clean(destination.record_kind);
  const idPrefix = clean(destination.id_prefix);
  if (!recordSetAddress || !routePrefix.startsWith('/') || !recordKind || !idPrefix) {
    throw new Error('Destination must name its record set, route prefix, record kind, and id prefix.');
  }
  if (clean(composition.route_prefix) !== routePrefix) {
    throw new Error('Destination and composition route prefixes must match.');
  }

  const paragraphs = visitDocumentNodes(snapshot.body.children);
  if (paragraphs.length < 2) throw new Error('A public article needs a title and at least one body block.');
  const titleIndex = paragraphs.findIndex((paragraph) => paragraph.heading_level === 1);
  const resolvedTitleIndex = titleIndex >= 0 ? titleIndex : 0;
  const title = paragraphs[resolvedTitleIndex].text;
  const body = paragraphs.filter((_, index) => index !== resolvedTitleIndex);
  if (!body.length) throw new Error('A public article needs body content after its title.');
  const documentRoute = composition.document_routes?.[snapshot.document_ref];
  let routeSlug;
  let routePath;
  if (documentRoute !== undefined) {
    routeSlug = routeSegment(documentRoute, routePrefix);
    if (!routeSlug) {
      throw new Error(`Composition document route must be one exact article route beneath ${routePrefix}.`);
    }
    routePath = documentRoute;
  } else {
    routeSlug = slug(title);
    if (!routeSlug) throw new Error('The Documents title does not produce a public route.');
    routePath = `${routePrefix}/${routeSlug}`;
  }
  const summary = body.find((paragraph) => paragraph.heading_level === null)?.text ?? body[0].text;
  const excerpt = clean(summary).replace(/\s+/g, ' ').slice(0, 220);
  const relatedCards = composition.related_cards;
  if (relatedCards.some((card) => !isRecord(card) || !clean(card.title) || !clean(card.href))) {
    throw new Error('Every related card must include a title and href.');
  }
  const otherRelatedCards = relatedCards.filter((card) => clean(card.href) !== routePath);
  const blocks = publicBlocks(body, sources, composition);
  if (otherRelatedCards.length) blocks.push({ kind: 'card-grid', items: otherRelatedCards });

  const page = {
    id: `${idPrefix}${routeSlug}`,
    kind: recordKind,
    route_path: routePath,
    title,
    meta_description: excerpt,
    brand_label: composition.brand_label,
    ...(clean(composition.brand_logo) ? { brand_logo: clean(composition.brand_logo) } : {}),
    eyebrow: composition.eyebrow,
    palette: composition.palette,
    layout: composition.layout,
    navigation: composition.navigation,
    blocks,
    schema: composition.schema ? {...composition.schema,headline:title,description:excerpt} : undefined,
    source_refs: [...new Set(body.flatMap((paragraph) => paragraph.refs))],
    ...(composition.checkout_offer_id ? { checkout_offer_id: composition.checkout_offer_id } : {}),
    ...(composition.checkout_price_option_id ? { checkout_price_option_id: composition.checkout_price_option_id } : {}),
    ...(composition.inline_checkout === true ? { inline_checkout: true } : {}),
    ...(composition.checkout_title ? { checkout_title: composition.checkout_title } : {}),
    ...(composition.checkout_description ? { checkout_description: composition.checkout_description } : {}),
    ...(composition.membership_href ? { membership_href: composition.membership_href } : {}),
    ...(composition.membership_label ? { membership_label: composition.membership_label } : {}),
    ...(composition.member_library_href ? { member_library_href: composition.member_library_href } : {}),
  };
  const pageRef = `${recordSetAddress}::${routePath}`;
  return {
    state: 'review-required',
    document_ref: snapshot.document_ref,
    document_revision_hash: snapshot.document_revision_hash,
    route_path: routePath,
    page_ref: pageRef,
    page,
    publication: {
      action: 'action:public-document-site:publish-composed-document',
      review_state: 'unavailable',
      write_allowed: false,
    },
  };
}

export { slug as slugPublicDocumentTitle };
