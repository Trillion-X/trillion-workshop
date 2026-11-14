import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'; // L136-EXEMPT this is a build-time CLI deriver, not a reactive one; the two readdirSync call sites below each carry their own reason
import path from 'node:path';
import { authoredVersionLineage } from './version-lineage.mjs';

const CATALOG_PACKAGE = 'bitfield-package-store-catalog';
const INSTALL_TARGET = 'package-files.install-packages-from-pointers';
const PREVIEW_ART_STORED_BYTES_NAME = 'package-preview-art';
const PREVIEW_ART_KIND = 'package-owned-preview-art';
const SCHEMA = 'bitfield.package_store.catalog.v3';
const SCHEMA_VERSION = 3;

const config = readConfig(process.argv.slice(2));
const proof = readJson(config.proofPath, 'package-use proof');
const offerExchange = readJson(config.offerExchangePath, 'offer exchange');
const packageFindingLanguage = readJson(config.packageFindingLanguagePath, 'package finding language');
const collectionDefinitions = readCollectionDefinitions();
const packageUseDecisionRef = `package-set:${proof.package_set}/what-packages-were-used-and-why`;
const candidates = new Map(proof.candidates.map((candidate) => [candidate.package, candidate]));
const offerContractsByResource = mapOfferContractsByResource(offerExchange);
const purchaseOptionsByResource = mapPurchaseOptionsByResource(offerExchange);
const packageFileDownloadPointerObjectKeys = readPackageFileDownloadPointerObjectKeys(proof.package_set);
const publisherTrustRoots = readPublisherTrustRoots();
const rows = proof.admitted_packages.map((packageName) => packageRow(packageName));

rows.push(packageSetRecipeRow(rows));

// Add collection rows with discovery metadata
for (const collectionDef of collectionDefinitions) {
  rows.push(collectionRow(collectionDef));
}

// Add engine acquisition rows (the engine offered as a store Acquirable). These are
// complete authored catalog rows in data/engine-offer.json (same shape package/collection
// rows produce), so they merge directly — mirrors the collection-definitions merge.
for (const engineRow of readEngineOfferRows()) {
  rows.push(engineRow);
}

const catalog = {
  schema: SCHEMA,
  schema_version: SCHEMA_VERSION,
  catalog_id: `${proof.package_set}:catalog:package-use-proof`,
  generated_from: {
    kind: 'package-use-proof-derived-catalog',
    package_use_decision_ref: packageUseDecisionRef,
    proof_file: path.relative(config.packageSetRoot, config.proofPath),
    facts_file: proof.facts_for_deciding_what_packages_can_be_used,
    facts_signature_verified: proof.facts_signature_verified === true,
    rules_file: proof.rules_for_deciding_what_packages_can_be_used,
    rules_signature_verified: proof.rules_signature_verified === true,
    admitted_package_count: proof.admitted_packages.length,
    rejected_package_count: Array.isArray(proof.rejected_packages) ? proof.rejected_packages.length : 0,
  },
  discovery: readCatalogDiscovery(),
  catalog_rows: rows,
};

mkdirSync(path.dirname(config.outputPath), { recursive: true });
writeFileSync(config.outputPath, `${JSON.stringify(catalog, null, 2)}\n`);

function readConfig(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value) {
      throw new Error(`Expected --key value arguments, got ${args.join(' ')}`);
    }
    values.set(key.slice(2), value);
  }

  const packageSetRoot = path.resolve(values.get('package-set-root') ?? process.cwd());
  return {
    packageSetRoot,
    proofPath: path.resolve(packageSetRoot, values.get('proof') ?? 'what-packages-were-used-and-why/what-packages-were-used-and-why.json'),
    offerExchangePath: path.resolve(packageSetRoot, values.get('offer-exchange') ?? 'packages/bitfield-package-store-offer-exchange/data/offer-exchange-fixture.json'),
    packageFindingLanguagePath: path.resolve(packageSetRoot, values.get('package-finding-language') ?? 'packages/bitfield-package-store-catalog/data/package-finding-language.json'),
    outputPath: path.resolve(packageSetRoot, values.get('output') ?? 'packages/bitfield-package-store-catalog/data/catalog.json'),
  };
}

function packageRow(packageName) {
  const candidate = requireCandidate(packageName);
  const contract = readPackageContract(packageName);
  const summary = packageSummary(packageName, contract);
  const capabilitySummary = packageCapabilitySummary(packageName, contract);
  const capabilityIds = capabilitySummary.map((capability) => `${packageName}.${slug(capability)}`);
  const signedContracts = offerContractsByResource.get(`resource:package:${packageName}`) ?? [];
  const previewArt = readPreviewArt({
    ownerIdentity: packageName,
    packageName,
    contract,
  });
  const displayName = displayPackageName(packageName);
  const exchange = exchangeFor({
    identity: packageName,
    resourceIdentity: packageName,
    signedContracts,
    candidate,
  });

  const row = {
    row_kind: 'package-row',
    row_id: `package:${packageName}`,
    package_identity: packageName,
    display_name: displayName,
    summary,
    capability_metadata: {
      capability_ids: capabilityIds,
      public_capability_summary: capabilitySummary,
    },
    source_package: {
      package_set_relative_path: candidate.source_path,
      contract_path: `${candidate.source_path}/things-to-store-and-run.json`,
      contract_hash: candidate.contract_hash,
      material_hash: packageName === CATALOG_PACKAGE
        ? `self:derived-catalog-snapshot:${packageUseDecisionRef}`
        : candidate.material_hash,
      source_package_set_context: proof.package_set,
    },
    install: {
      install_subject: {
        action_label: 'Install package',
        package_identity: packageName,
        subject_label: displayName,
        subject_ref: `package:${packageName}`,
        subject_type_ref: 'install-subject:package',
      },
      target: INSTALL_TARGET,
    },
    exchange,
    signed_package_file_metadata_pointers: [],
    package_use_decision_refs: [packageUseDecisionRef],
    access_policy_refs: ['public-package-use'],
    visibility: {
      source: 'source-visible',
      execution: 'local',
    },
    remote_surface_descriptor_refs: [],
    preview_art: previewArt,
    visual_detail_refs: previewArt ? [previewArt.material_ref] : [],
    publisher_trust_root_refs: [`package-set:${proof.package_set}`],
    publisher_trust_roots: publisherTrustRoots,
    // Version-lineage facets (D1): the key is emitted ONLY when the package's own contract authors a
    // real `version_lineage` (a publish-time concern). No authored metadata => the key is omitted
    // entirely — never a null-filler and never a fabricated default (L117). The detail reader surfaces
    // "Version & Compatibility" sparsely, so an omitted key renders nothing. When a publish stamps a real
    // version onto the contract, it appears with zero code change (DATA-driven).
    ...(authoredVersionLineage(contract) ? { version_lineage: authoredVersionLineage(contract) } : {}),
  };
  return withPackageFinding(row);
}

function packageSetRecipeRow(packageRows) {
  const recipeIdentity = `${proof.package_set}-substrate`;
  const signedContracts = offerContractsByResource.get(`resource:package-set:${recipeIdentity}`) ?? [];
  const previewArt = readPreviewArt({
    ownerIdentity: recipeIdentity,
    packageName: CATALOG_PACKAGE,
    contract: readPackageContract(CATALOG_PACKAGE),
  });
  const exchange = exchangeFor({
    identity: recipeIdentity,
    resourceIdentity: recipeIdentity,
    signedContracts,
    candidate: null,
  });
  const row = {
    row_kind: 'package-set-row',
    row_id: `recipe:${recipeIdentity}`,
    recipe_identity: recipeIdentity,
    package_set_identity: proof.package_set,
    display_name: 'Bitfield Package Store Package Set',
    summary: 'A ready package set for the hosted and local Package Store.',
    capability_metadata: {
      capability_ids: [
        `${proof.package_set}.signed-catalog-projection`,
        `${proof.package_set}.local-install-request`,
        `${proof.package_set}.creator-publish-request`,
        `${proof.package_set}.package-update-policy`,
      ],
      public_capability_summary: [
        'Package list',
        'Local package install',
        'Creator publishing',
        'Package update rules',
      ],
    },
    recipe: {
      package_members: packageRows.map((row) => ({
        package_identity: row.package_identity,
        required_capability_ids: row.capability_metadata.capability_ids.slice(0, 2),
      })),
      initial_config_refs: [
        'package::bitfield-package-store-screen-root::published-record::screen-root',
      ],
    },
    source_package_set: {
      package_set_relative_path: '.',
      material_hash_ref: `package-set-material:derived-from:${packageUseDecisionRef}`,
      package_use_decision_ref: packageUseDecisionRef,
    },
    install: {
      install_subject: {
        action_label: 'Install package set',
        package_set_identity: proof.package_set,
        recipe_identity: recipeIdentity,
        subject_label: 'Bitfield Package Store Package Set',
        subject_ref: `package-set-recipe:${recipeIdentity}`,
        subject_type_ref: 'install-subject:package-set-recipe',
      },
      target: INSTALL_TARGET,
    },
    exchange,
    signed_package_file_metadata_pointers: [],
    package_use_decision_refs: [packageUseDecisionRef],
    access_policy_refs: ['public-package-use'],
    visibility: {
      source: 'source-visible',
      execution: 'local',
    },
    remote_surface_descriptor_refs: [],
    preview_art: previewArt,
    visual_detail_refs: previewArt ? [previewArt.material_ref] : [],
    publisher_trust_root_refs: [`package-set:${proof.package_set}`],
    publisher_trust_roots: publisherTrustRoots,
  };
  return withPackageFinding(row);
}

function collectionRow(collectionDef) {
  const collectionIdentity = collectionDef.collection_id;
  const signedContracts = offerContractsByResource.get(`resource:collection:${collectionIdentity}`) ?? [];
  const exchange = exchangeFor({
    identity: collectionIdentity,
    resourceIdentity: collectionIdentity,
    signedContracts,
    candidate: null,
  });
  const row = {
    row_kind: 'collection-row',
    row_id: `collection:${collectionIdentity}`,
    collection_id: collectionIdentity,
    display_name: collectionDef.display_name,
    summary: collectionDef.summary,
    capability_metadata: {
      public_capability_summary: collectionDef.capability_metadata?.public_capability_summary ?? [],
    },
    members: collectionDef.members ?? [],
    install: {
      install_subject: {
        action_label: 'Get all packages',
        subject_label: collectionDef.display_name,
        subject_ref: `collection:${collectionIdentity}`,
        subject_type_ref: 'install-subject:collection',
      },
      target: INSTALL_TARGET,
    },
    exchange,
    signed_package_file_metadata_pointers: [],
    access_policy_refs: ['public-package-use'],
    visibility: {
      source: 'source-visible',
      execution: 'local',
    },
    remote_surface_descriptor_refs: [],
    preview_art: null,
    visual_detail_refs: [],
    publisher_trust_root_refs: [`package-set:${proof.package_set}`],
    publisher_trust_roots: publisherTrustRoots,
  };
  return withPackageFinding(row);
}

function readPreviewArt({ ownerIdentity, packageName, contract }) {
  const previewThing = contract.things.find((thing) => (
    thing?.type === 'stored_bytes' &&
    thing?.name === PREVIEW_ART_STORED_BYTES_NAME
  ));
  if (!previewThing) return null;

  const sourcePath = firstString([previewThing.source_path]);
  if (!sourcePath) {
    throw new Error(`${packageName} preview art stored bytes has no source_path`);
  }

  const absolutePath = path.join(config.packageSetRoot, 'packages', packageName, sourcePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`${packageName} preview art does not exist: ${absolutePath}`);
  }

  const bytes = readFileSync(absolutePath);
  const mediaType = firstString([previewThing.media_type]);
  if (!mediaType) {
    throw new Error(`${packageName} preview art stored bytes has no media_type`);
  }
  const sourcePackagePath = path.posix.join('packages', packageName, sourcePath.split(path.sep).join('/'));
  return {
    kind: PREVIEW_ART_KIND,
    owner_identity: ownerIdentity,
    source_package: packageName,
    stored_bytes_name: PREVIEW_ART_STORED_BYTES_NAME,
    media_type: mediaType,
    source_path: sourcePackagePath,
    byte_length: bytes.byteLength,
    material_ref: `${PREVIEW_ART_STORED_BYTES_NAME}:${ownerIdentity}:${sourcePackagePath}`,
    data_url: `data:${mediaType};base64,${bytes.toString('base64')}`,
  };
}

function exchangeFor({ identity, resourceIdentity, signedContracts, candidate }) {
  const contractRefs = signedContracts.map((contract) => contract.contract_ref);
  const resourceRef = firstString(signedContracts.flatMap((contract) => stringArray(contract.resource_refs)))
    ?? (resourceIdentity.startsWith('resource:')
      ? resourceIdentity
      : `resource:package:${resourceIdentity}`);
  const quoteTargets = unique(signedContracts.flatMap((contract) => stringArray(contract.quote_reservation_target_refs)));
  const meterUnits = unique(signedContracts.flatMap((contract) => stringArray(contract.meter_unit_refs)));
  const signedPolicyRefs = unique(signedContracts.flatMap((contract) => stringArray(contract.policy_refs)));
  const purchaseOptions = objectArray(purchaseOptionsByResource.get(resourceRef))
    .filter((option) => {
      const contractRef = option.contract_ref;
      return typeof contractRef === 'string' && (
        contractRefs.length === 0 || contractRefs.includes(contractRef)
      );
    });
  const accountOwnerTargets = contractRefs.length === 0
    ? []
    : objectArray(offerExchange.owner_targets)
      .map((target) => target.target_ref)
      .filter((targetRef) => typeof targetRef === 'string')
      .filter((targetRef) => targetRef.startsWith('owner-target:account-portal/'));

  return {
    package_file_download_pointer_object_keys: packageFileDownloadPointerObjectKeys,
    package_file_metadata_pointer_refs: packageFileDownloadPointerObjectKeys.map((objectKey) => (
      `package-file-download-pointer:${objectKey}`
    )),
    package_use_decision_refs: [packageUseDecisionRef],
    access: {
      admission_fact_refs: ['package-use:public'],
      product_access_proof_refs: accountOwnerTargets.length === 0
        ? []
        : [`product-access-proof:account-portal:${identity}`],
      required_owner_target_refs: accountOwnerTargets,
    },
    offer: {
      display_ref: signedContracts[0]?.display_ref ?? null,
      signed_deal_contract_refs: contractRefs,
      quote_reservation_target_refs: quoteTargets,
      meter_unit_refs: meterUnits,
      policy_refs: signedPolicyRefs.length > 0 ? signedPolicyRefs : ['policy:public-package-use'],
      purchase_options: purchaseOptions,
    },
    update_policy_refs: contractRefs.length > 0
      ? existingUpdatePolicyRefs([
        'update-policy:trusted-publisher-auto-accept',
        'update-policy:pinned-version-supported',
        'update-policy:rollback-supported',
      ])
      : existingUpdatePolicyRefs(['update-policy:manual-approval']),
    provenance_refs: provenanceRefs(resourceIdentity, candidate),
  };
}

function readPackageFileDownloadPointerObjectKeys(packageSet) {
  const pointerDir = path.join(
    config.packageSetRoot,
    'package-file-downloads-and-approval-records',
    'filesystem-object-store',
    'package-sets',
    packageSet,
    'package-files',
  );
  if (!existsSync(pointerDir)) return [];
  return readdirSync(pointerDir, { withFileTypes: true }) // L136-EXEMPT build-time read of artifacts a signer already wrote, whose names this cannot know in advance; no watch, no poll, no schedule, no dispatch, no delivery
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => `package-sets/${packageSet}/package-files/${entry.name}`)
    .sort();
}

function readPublisherTrustRoots() {
  const trustRootDir = path.join(
    config.packageSetRoot,
    'package-file-downloads-and-approval-records',
    'signing-keys-allowed-to-approve-package-files',
  );
  if (!existsSync(trustRootDir)) return [];
  return readdirSync(trustRootDir, { withFileTypes: true }) // L136-EXEMPT build-time read of the signing keys allowed to approve package files, written by the signer, names unknowable in advance; no watch, no poll, no schedule
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .flatMap((entry) => {
      const value = readJson(path.join(trustRootDir, entry.name), `publisher trust root ${entry.name}`);
      return Array.isArray(value) ? objectArray(value) : objectArray([value]);
    })
    .sort((left, right) => String(left.trust_root_id ?? '').localeCompare(String(right.trust_root_id ?? '')));
}

function provenanceRefs(resourceIdentity, candidate) {
  const refs = [
    `publisher-trust-root:package-set:${proof.package_set}`,
    packageUseDecisionRef,
    `resource:${resourceIdentity}`,
  ];
  if (!candidate) return refs;
  refs.push(
    `source-material:${candidate.source_path}`,
    `contract:${candidate.contract_hash}`,
  );
  if (candidate.package === CATALOG_PACKAGE) {
    refs.push(`material:self-derived:${packageUseDecisionRef}`);
  } else {
    refs.push(`material:${candidate.material_hash}`);
  }
  if (Array.isArray(candidate.emitted_record_addresses)) {
    refs.push(`emitted-record-count:${candidate.emitted_record_addresses.length}`);
  }
  return refs;
}

function existingUpdatePolicyRefs(refs) {
  const available = new Set(objectArray(offerExchange.update_policies).map((policy) => policy.update_policy_ref));
  return refs.filter((ref) => available.has(ref));
}

function mapOfferContractsByResource(exchange) {
  const contractsByResource = new Map();
  for (const contract of objectArray(exchange.signed_deal_contracts)) {
    for (const resourceRef of stringArray(contract.resource_refs)) {
      const contracts = contractsByResource.get(resourceRef) ?? [];
      contracts.push(contract);
      contractsByResource.set(resourceRef, contracts);
    }
  }
  return contractsByResource;
}

function mapPurchaseOptionsByResource(exchange) {
  const optionsByResource = new Map();
  for (const option of objectArray(exchange.purchase_options)) {
    const resourceRef = typeof option.resource_ref === 'string' ? option.resource_ref : '';
    if (!resourceRef) continue;
    const options = optionsByResource.get(resourceRef) ?? [];
    options.push(option);
    optionsByResource.set(resourceRef, options);
  }
  return optionsByResource;
}

function readPackageContract(packageName) {
  const contractPath = path.join(config.packageSetRoot, 'packages', packageName, 'things-to-store-and-run.json');
  const contract = readJson(contractPath, `${packageName} package contract`);
  return {
    things: Array.isArray(contract.things) ? contract.things : [],
  };
}

function readCollectionDefinitions() {
  const definitionsPath = path.resolve(
    config.packageSetRoot,
    'packages/bitfield-package-store-catalog/data/collection-definitions.json'
  );
  if (!existsSync(definitionsPath)) {
    return [];
  }
  const data = readJson(definitionsPath, 'collection definitions');
  return Array.isArray(data.collections) ? data.collections : [];
}

function readEngineOfferRows() {
  const engineOfferPath = path.resolve(
    config.packageSetRoot,
    'packages/bitfield-package-store-catalog/data/engine-offer.json'
  );
  if (!existsSync(engineOfferPath)) {
    return [];
  }
  const data = readJson(engineOfferPath, 'engine offer');
  return Array.isArray(data.engine_acquisition_rows) ? data.engine_acquisition_rows : [];
}

function packageSummary(packageName, contract) {
  const description = firstString(contract.things
    .map((thing) => thing?.payload?.description)
    .filter(Boolean));
  if (description) return publicSummary(description);

  const contractRecord = packageContractRecord(packageName, contract);
  const owns = stringArray(contractRecord?.owns);
  if (owns.length > 0) {
    return `Provides ${displayPackageName(packageName)} for the Package Store.`;
  }

  return `Provides ${displayPackageName(packageName)} package files for the Package Store.`;
}

function publicSummary(value) {
  return rewritePublicText(value, packageFindingLanguage.summary_rewrites);
}

function packageCapabilitySummary(packageName, contract) {
  const contractRecord = packageContractRecord(packageName, contract);
  const owns = stringArray(contractRecord?.owns);
  const storedBytes = contract.things
    .filter((thing) => thing?.type === 'stored_bytes')
    .map((thing) => thing.name)
    .filter((value) => typeof value === 'string');
  const descriptions = contract.things
    .map((thing) => thing?.payload?.description)
    .filter((value) => typeof value === 'string')
    .map((value) => value.split(/[.;]/, 1)[0])
    .filter(Boolean);

  const capabilities = unique([...owns, ...descriptions, ...storedBytes])
    .map(publicCapabilityName)
    .filter(Boolean)
    .slice(0, 4);
  return capabilities.length > 0 ? capabilities : [`${displayPackageName(packageName)} package files`];
}

function publicCapabilityName(value) {
  const normalized = String(value).trim().toLowerCase();
  const semanticName = normalized.replace(/[_:-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = packageFindingLanguage.capability_labels?.[normalized]
    ?? packageFindingLanguage.capability_labels?.[semanticName];
  if (exact) return exact;

  return labelize(rewritePublicText(String(value), packageFindingLanguage.summary_rewrites));
}

function withPackageFinding(row) {
  const source = row.visibility?.source ?? 'source-unknown';
  const execution = row.visibility?.execution ?? 'execution-unknown';
  const identity = row.package_identity ?? row.recipe_identity ?? row.package_set_identity ?? row.row_id;
  const capabilities = stringArray(row.capability_metadata?.public_capability_summary);
  const kind = labelConfig(packageFindingLanguage.row_kind_labels?.[row.row_kind], row.row_kind);
  const sourceConfig = labelConfig(packageFindingLanguage.source_labels?.[source], source);
  const executionConfig = labelConfig(packageFindingLanguage.execution_labels?.[execution], execution);
  const access = readAccessFinding(row.exchange);
  const searchCorpus = unique([
    row.display_name,
    row.summary,
    identity,
    row.row_kind,
    source,
    execution,
    ...capabilities,
  ]);
  const categories = inferFindingCollection(packageFindingLanguage.categories, searchCorpus);
  const shelves = inferFindingCollection(packageFindingLanguage.shelves, [
    ...searchCorpus,
    sourceConfig.label,
    executionConfig.label,
    access.label,
  ]);
  const facets = uniqueById([
    findingFacet('all', 'All', 'all'),
    findingFacet(row.row_kind, kind.label, kind.facet_group ?? 'kind'),
    findingFacet(`source:${source}`, sourceConfig.label, sourceConfig.facet_group ?? 'source'),
    findingFacet(`execution:${execution}`, executionConfig.label, executionConfig.facet_group ?? 'runtime'),
    findingFacet(`access:${access.id}`, access.facet_label, access.facet_group ?? 'access'),
    ...categories.map((category) => findingFacet(`category:${category.id}`, category.label, 'category', category.description)),
    ...capabilities.map((capability) => findingFacet(`capability:${slug(capability)}`, capability, 'capability')),
  ]);
  const detailTitles = packageFindingLanguage.detail_block_titles ?? {};
  const blockValues = {
    display_creator: packageFindingLanguage.default_creator_text ?? 'Bitfield',
    display_kind: kind.label,
    display_access: access.label,
    display_source: sourceConfig.label,
    display_runtime: executionConfig.label,
    display_action: row.install?.install_subject?.action_label ?? 'Install',
  };
  const toneValues = {
    row_kind: row.row_kind,
    access: access.id,
    source,
    execution,
    action: row.install?.target,
  };

  return {
    ...row,
    package_finding: {
      schema: 'bitfield.package_store.package_finding.v1',
      row_id: row.row_id,
      title: row.display_name,
      summary: row.summary,
      blocks: findingBlocks(blockValues, toneValues),
      categories,
      capabilities,
      facets,
      shelf_ids: unique(['featured', ...shelves.map((shelf) => shelf.id)]),
      search: {
        aliases: unique([
          row.display_name,
          identity,
          ...capabilities,
          ...categories.map((category) => category.label),
          ...shelves.map((shelf) => shelf.label),
        ]),
        text: unique([
          ...searchCorpus,
          ...facets.map((facet) => facet.label),
          ...categories.map((category) => category.description),
        ]).join(' ').toLowerCase(),
      },
      ranking: {
        score: packageFindingScore({ access, categories, capabilities, previewArt: row.preview_art, source, execution }),
        signals: [
          findingFacet('has-preview', row.preview_art ? 'Has preview image' : 'No preview image yet', 'quality'),
          findingFacet(`source:${source}`, sourceConfig.label, 'source'),
          findingFacet(`execution:${execution}`, executionConfig.label, 'runtime'),
        ],
        result_explanations: [
          `${kind.label} / ${sourceConfig.label} / ${executionConfig.label}`,
          access.facet_label,
        ],
      },
      detail_blocks: [
        {
          id: 'what-it-does',
          title: detailTitles.what_it_does ?? 'What it does',
          body: row.summary,
        },
        {
          id: 'best-for',
          title: detailTitles.best_for ?? 'Best for',
          items: categories.length > 0
            ? categories.map((category) => `${category.label}: ${category.description}`)
            : capabilities,
        },
        {
          id: 'before-install',
          title: detailTitles.before_install ?? 'Before you install',
          items: [sourceConfig.label, executionConfig.label, access.facet_label],
        },
      ],
    },
  };
}

function findingBlocks(values, tones) {
  return objectArray(packageFindingLanguage.finding_blocks)
    .map((definition) => {
      const id = String(definition.id ?? '');
      const role = String(definition.role ?? '');
      const renderKind = String(definition.render_kind ?? role);
      const value = values[String(definition.value_source ?? '')];
      if (!id || !role || value === undefined || value === null || value === '') {
        return null;
      }
      const tone = tones[String(definition.tone_source ?? '')];
      return {
        id,
        role,
        render_kind: renderKind,
        label: typeof definition.label === 'string' ? definition.label : undefined,
        value,
        ...(typeof tone === 'string' && tone ? { tone_key: tone } : {}),
      };
    })
    .filter(Boolean);
}

function readAccessFinding(exchange) {
  const purchaseOptions = objectArray(exchange?.offer?.purchase_options);
  const paidOption = purchaseOptions.some((option) => {
    const amount = typeof option.amount_due_today_cents === 'string' && /^\d+$/.test(option.amount_due_today_cents)
      ? BigInt(option.amount_due_today_cents)
      : 0n;
    return amount > 0n;
  });
  const hasDealContract = stringArray(exchange?.offer?.signed_deal_contract_refs).length > 0;
  const needsAccount = stringArray(exchange?.access?.required_owner_target_refs).length > 0;
  const id = paidOption || hasDealContract ? 'paid' : needsAccount ? 'account' : 'public';
  const config = packageFindingLanguage.access_labels?.[id] ?? {};
  return {
    id,
    label: config.label ?? labelize(id),
    facet_label: config.facet_label ?? config.label ?? labelize(id),
    facet_group: config.facet_group ?? 'access',
  };
}

function labelConfig(value, fallbackId) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      label: typeof value.label === 'string' && value.label ? value.label : labelize(fallbackId),
      detail: typeof value.detail === 'string' ? value.detail : undefined,
      facet_group: typeof value.facet_group === 'string' ? value.facet_group : undefined,
    };
  }
  return { label: labelize(fallbackId), detail: undefined, facet_group: undefined };
}

function findingFacet(id, label, group, description = undefined) {
  return { id, label, group, ...(description ? { description } : {}) };
}

function inferFindingCollection(collection, corpus) {
  if (!Array.isArray(collection)) return [];
  const normalizedCorpus = corpus.map((value) => String(value).toLowerCase()).join(' ');
  return collection
    .filter((item) => {
      const terms = stringArray(item?.match_terms).map((term) => term.toLowerCase());
      return terms.some((term) => normalizedCorpus.includes(term));
    })
    .map((item) => ({
      id: String(item.id),
      label: String(item.label),
      description: typeof item.description === 'string' ? item.description : '',
    }))
    .filter((item) => item.id.length > 0 && item.label.length > 0);
}

function readCatalogDiscovery() {
  return {
    schema: 'bitfield.package_store.discovery.v1',
    categories: discoveryItems(packageFindingLanguage.categories),
    shelves: discoveryItems(packageFindingLanguage.shelves),
    replacement_catalog: readReplacementCatalog(),
    no_result_recovery: objectArray(packageFindingLanguage.no_result_recovery)
      .map((item) => ({
        id: String(item.id ?? ''),
        label: String(item.label ?? ''),
        description: String(item.description ?? ''),
        filter_id: String(item.filter_id ?? ''),
        query: String(item.query ?? ''),
      }))
      .filter((item) => item.id && item.label && item.filter_id),
  };
}

function readReplacementCatalog() {
  const catalogPath = path.resolve(
    config.packageSetRoot,
    'packages/bitfield-package-store-catalog/data/replacement-catalog.json',
  );
  if (!existsSync(catalogPath)) {
    return {
      schema: 'bitfield.package_store.replacement_catalog.v1',
      schema_version: 1,
      catalog_id: 'bitfield-package-store:replacement-catalog',
      competitors: [],
      package_evidence: [],
      compositions: [],
    };
  }
  return readJson(catalogPath, 'replacement catalog');
}

function discoveryItems(collection) {
  return objectArray(collection)
    .map((item, index) => ({
      id: String(item.id ?? ''),
      label: String(item.label ?? ''),
      description: String(item.description ?? ''),
      match_terms: stringArray(item.match_terms),
      priority: Number.isFinite(item.priority) ? Number(item.priority) : index * 10,
    }))
    .filter((item) => item.id && item.label);
}

function packageFindingScore({ access, categories, capabilities, previewArt, source, execution }) {
  const weights = packageFindingLanguage.ranking_weights ?? {};
  const weight = (key, fallback) => Number.isFinite(weights[key]) ? Number(weights[key]) : fallback;
  return [
    previewArt ? weight('has_preview', 30) : 0,
    source === 'source-visible' ? weight('source_visible', 20) : 0,
    execution === 'local' ? weight('local_execution', 20) : 0,
    access.id === 'public' ? weight('public_access', 10) : 0,
    Math.min(categories.length * weight('category', 6), weight('category_max', 18)),
    Math.min(capabilities.length * weight('capability', 4), weight('capability_max', 16)),
  ].reduce((total, value) => total + value, 0);
}

function rewritePublicText(value, rules) {
  if (!rules || typeof rules !== 'object') return cleanText(value);
  const exact = rules.exact?.[value];
  if (typeof exact === 'string') return exact;

  const lowered = value.toLowerCase();
  for (const rule of objectArray(rules.prefixes)) {
    const prefix = typeof rule.prefix === 'string' ? rule.prefix.toLowerCase() : '';
    const contains = typeof rule.contains === 'string' ? rule.contains : '';
    const replacement = typeof rule.replacement === 'string' ? rule.replacement : '';
    if (prefix && replacement && lowered.startsWith(prefix) && (!contains || value.includes(contains))) {
      return replacement;
    }
  }

  let text = value;
  for (const rule of objectArray(rules.replacements)) {
    const pattern = typeof rule.pattern === 'string' ? rule.pattern : '';
    const replacement = typeof rule.replacement === 'string' ? rule.replacement : '';
    const flags = typeof rule.flags === 'string' ? rule.flags : 'g';
    if (!pattern) continue;
    text = text.replace(new RegExp(pattern, flags), replacement);
  }

  return cleanText(text);
}

function cleanText(value) {
  return String(value)
    .replace(/\s+/g, ' ')
    .replace(/\s+\./g, '.')
    .trim();
}

function packageContractRecord(packageName, contract) {
  return contract.things.find((thing) => (
    thing?.type === 'record' &&
    thing?.address === `package::${packageName}::contract` &&
    thing?.payload &&
    typeof thing.payload === 'object'
  ))?.payload;
}

function requireCandidate(packageName) {
  const candidate = candidates.get(packageName);
  if (!candidate) {
    throw new Error(`Admitted package ${packageName} has no proof candidate`);
  }
  return candidate;
}

function readJson(filePath, label) {
  if (!existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function objectArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function firstString(values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? null;
}

function displayPackageName(packageName) {
  const publicName = packageFindingLanguage.package_name_labels?.[packageName];
  if (publicName) return publicName;

  const name = packageName.startsWith('bitfield-package-store-')
    ? packageName.slice('bitfield-package-store-'.length)
    : packageName;
  return labelize(name);
}

function labelize(value) {
  const uppercaseWords = new Set(['eeaf', 'ui']);
  return String(value)
    .replace(/[_:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => uppercaseWords.has(word.toLowerCase())
      ? word.toUpperCase()
      : `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function sentenceList(values) {
  return values.map((value) => String(value).trim()).filter(Boolean).join(', ');
}

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function unique(values) {
  return Array.from(new Set(values.filter((value) => typeof value === 'string' && value.length > 0)));
}

function uniqueById(values) {
  const seen = new Set();
  return values.filter((value) => {
    if (!value || typeof value.id !== 'string' || seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}
