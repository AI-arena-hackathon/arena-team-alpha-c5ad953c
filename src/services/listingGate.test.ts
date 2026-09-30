import { buildContainer, type Container } from '../container';
import { ListingGate } from './listingGate';
import { eidasAssertion, healthySubmission, TEST_MARKETPLACE, TEST_NOW, testConfig } from '../testing/fixtures';
import { fixedClock } from '../util/clock';

function buildTestContainer(): Container {
  return buildContainer({ config: testConfig(), clock: fixedClock(TEST_NOW) });
}

async function submitHealthy(container: Container, overrides = {}) {
  return container.kycService.submit(TEST_MARKETPLACE, healthySubmission(overrides));
}

describe('ListingGate', () => {
  it('allows a listing once the seller is verified', async () => {
    const container = buildTestContainer();
    await submitHealthy(container);

    const decision = await container.listingGate.check({
      marketplaceId: TEST_MARKETPLACE,
      listingId: 'listing-9001',
      subjectId: 'seller-777',
    });

    expect(decision).toMatchObject({
      allowed: true,
      status: 'verified',
      requiredAction: 'none',
      riskScore: 0,
      checkedAt: TEST_NOW,
    });
  });

  it('blocks a seller that has never submitted KYC, and says what to do', async () => {
    const container = buildTestContainer();
    const decision = await container.listingGate.check({
      marketplaceId: TEST_MARKETPLACE,
      listingId: 'listing-9001',
      subjectId: 'seller-unknown',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('unknown');
    expect(decision.reason).toMatch(/no KYC submission/);
    expect(decision.requiredAction).toMatch(/submit a KYC submission/);
    expect(decision.riskScore).toBeNull();
  });

  it('blocks a seller pending review and names the pending risk score', async () => {
    const container = buildTestContainer();
    await submitHealthy(container, { claims: { politicallyExposed: true } });

    const decision = await container.listingGate.check({
      marketplaceId: TEST_MARKETPLACE,
      listingId: 'listing-9001',
      subjectId: 'seller-777',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('review');
    expect(decision.reason).toMatch(/pending compliance review \(risk score 63\)/);
    expect(decision.riskScore).toBe(63);
  });

  it('blocks a rejected seller permanently', async () => {
    const container = buildTestContainer();
    await submitHealthy(container, { credential: { format: 'eidas', assertion: eidasAssertion({}, 'forged') } });

    const decision = await container.listingGate.check({
      marketplaceId: TEST_MARKETPLACE,
      listingId: 'listing-9001',
      subjectId: 'seller-777',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('rejected');
    expect(decision.requiredAction).toMatch(/escalate to compliance/);
  });

  it('uses the most recent assessment when a seller resubmits', async () => {
    const clock = fixedClock(TEST_NOW);
    const container = buildContainer({ config: testConfig(), clock });

    await submitHealthy(container, { submissionId: 'kyc_submission_aaa' });
    clock.advance(60_000);
    await submitHealthy(container, {
      submissionId: 'kyc_submission_bbb',
      claims: { politicallyExposed: true },
    });

    const decision = await new ListingGate(container.repository, clock).check({
      marketplaceId: TEST_MARKETPLACE,
      listingId: 'listing-9001',
      subjectId: 'seller-777',
    });
    expect(decision.status).toBe('review');
  });

  it('does not leak a decision across marketplaces', async () => {
    const container = buildTestContainer();
    await submitHealthy(container);

    const decision = await container.listingGate.check({
      marketplaceId: 'market-beta',
      listingId: 'listing-9001',
      subjectId: 'seller-777',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.status).toBe('unknown');
  });

  it('records every check so the compliance report can count blocked listings', async () => {
    const container = buildTestContainer();
    await submitHealthy(container);

    await container.listingGate.check({ marketplaceId: TEST_MARKETPLACE, listingId: 'listing-ok', subjectId: 'seller-777' });
    await container.listingGate.check({ marketplaceId: TEST_MARKETPLACE, listingId: 'listing-bad', subjectId: 'nobody' });
    await container.listingGate.check({ marketplaceId: TEST_MARKETPLACE, listingId: 'listing-bad-2', subjectId: 'nobody' });

    expect(await container.repository.countListingDecisions(TEST_MARKETPLACE, true)).toBe(2);
    expect(await container.repository.countListingDecisions(TEST_MARKETPLACE, false)).toBe(1);
    expect(await container.repository.countListingDecisions('market-beta', true)).toBe(0);
  });
});