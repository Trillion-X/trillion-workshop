    const source = distributionSource(input.source_id);
    if (!configured || !source) throw new Error('Name a configured installation source.');
    if (Object.keys(input).some(name => !['source_id', 'publish'].includes(name))) throw new Error('This tool reads global release availability; private tester input is not accepted.');
    if (input.publish !== undefined && typeof input.publish !== 'boolean') throw new Error('Publish must be true or false.');
    const listing = await readListing(configured.listing);
    const asc = connect({ keychainService: listing.app_store_connect.key_keychain_service, issuerId: listing.app_store_connect.issuer_id });
    let apps;
    try { apps = await asc.get('/v1/apps', { query: { 'filter[bundleId]': listing.app.bundle_identifier, limit: 2 } }); }
    catch (error) { throw new Error(`The configured app could not be checked with Apple${Number.isInteger(error.status) ? ` (${error.status})` : ''}. No new availability was published.`); }
    const matches = Array.isArray(apps?.data) ? apps.data.filter(app => app?.attributes?.bundleId === listing.app.bundle_identifier) : [];
    if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id.trim() || apps?.links?.next) throw new Error('The configured app did not resolve to one complete Apple app record.');
    const checked = now();
    const report = await readAvailability({ asc, appId: matches[0].id, testflight: listing.testflight, now: checked });
    const observation = distributionObservation(source, report, checked);
    let published = null;
