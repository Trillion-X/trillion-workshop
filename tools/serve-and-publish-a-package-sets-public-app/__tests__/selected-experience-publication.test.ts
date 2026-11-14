import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import packageData from '../things-to-store-and-run.json' with { type: 'json' };

const source = JSON.stringify(packageData);

describe('selected experience publication closure', () => {
  it('keeps protocol DATA outside Workflow executable-definition hydration', () => {
    const protocol = packageData.things.find(
      (thing) => thing.address === 'package::hosted-public-app::workflow-protocol::selected-experience-publication',
    );
    expect(protocol?.path).toEqual(['current-item', 'published-record']);
    expect(protocol?.payload.kind).toBe('selected-experience-publication-workflow/v1');
    expect(protocol?.payload).not.toHaveProperty('id');

    const executableDefinitions = packageData.things.filter(
      (thing) => thing.path?.includes('workflow-definition'),
    );
    expect(executableDefinitions.length).toBeGreaterThan(0);
    expect(executableDefinitions.every(
      (thing) => thing.payload.kind === 'action' && typeof thing.payload.id === 'string',
    )).toBe(true);
  });

  it('binds create/apply to materializer archive bytes and commits only after verified closure stages', () => {
    expect(source).not.toContain('selected_projection_tree_root');
    expect(source).toContain('create-from-source-archive');
    expect(source).toContain('step_bytes');
    expect(source).not.toContain('publication_root');
    expect(source).not.toContain('verify_signed_hosted_projection_closure');
    expect(source).not.toContain('verify_applied_hosted_projection_closure');
    expect(source).toContain('commit_publication');
  });

  it('maps the buyer authority and all protected routes as selected stored bytes', () => {
    for (const storedByte of [
      'hosted-experience-authority-ts',
      'app-api-experience-manifest-route-ts',
      'app-api-experience-bytes-route-ts',
      'app-api-experience-data-route-ts',
      'app-api-experience-subscriptions-route-ts',
    ]) expect(source).toContain(storedByte);
  });
});
