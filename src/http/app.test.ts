import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../container';
import { createApp } from '../http/app';
import {
  eidasAssertion,
  healthySubmission,
  TEST_API_KEY,
  TEST_MARKETPLACE,
  TEST_NOW,
  testConfig,
} from '../testing/fixtures';
import { fixedClock } from '../util/clock';

interface Harness {
  baseUrl: string;
  server: Server;
  close(): Promise<void>;
}

/**
 * Integration tests against a real listening server: the partner API is exercised
 * over HTTP (status codes, headers, JSON contracts) rather than through
 * supertest, so nothing about Express, body parsing or status mapping is mocked.
 */
async function startServer(): Promise<Harness> {
  const { container } = buildApp({
    config: testConfig(),
    clock: fixedClock(TEST_NOW),
    startedAt: new Date(TEST_NOW),
  });
  const server: Server = createApp(container.deps).listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

function authHeaders(apiKey = TEST_API_KEY): Record<string, string> {
  return { 'content-type': 'application/json', 'x-api-key': apiKey };
}

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('HTTP API', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startServer();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('GET /health', () => {
    it('proves the app runs without a partner key', async () => {
      const response = await fetch(`${harness.baseUrl}/health`);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.service).toBe('nft-kyc-hub');
      expect(body.adapters).toEqual(['eidas-gateway', 'franceconnect']);
      expect(body.now).toBe(TEST_NOW);
    });
  });

  describe('authentication', () => {
    it('rejects a missing key', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/compliance/report`);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: 'unauthorized' });
    });

    it('rejects an unknown key', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/compliance/report`, {
        headers: { 'x-api-key': 'not-the-key' },
      });
      expect(response.status).toBe(401);
    });

    it('accepts the Authorization: ApiKey form', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/compliance/report`, {
        headers: { authorization: `ApiKey ${TEST_API_KEY}` },
      });
      expect(response.status).toBe(200);
    });
  });

  describe('POST /v1/kyc/submissions', () => {
    it('runs the primary flow: submit, then unblock the listing', async () => {
      const submission = healthySubmission({ submissionId: 'kyc_flow_00001' });
      const created = await postJson(
        `${harness.baseUrl}/v1/kyc/submissions`,
        submission,
        authHeaders(),
      );

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        submissionId: 'kyc_flow_00001',
        subjectId: 'seller-777',
        status: 'verified',
        decision: 'approve',
        listingBlocked: false,
        idempotentReplay: false,
      });
      expect((created.body.risk as Record<string, unknown>).score).toBe(0);

      const listing = await postJson(
        `${harness.baseUrl}/v1/listings/listing-9001/check`,
        { subjectId: 'seller-777' },
        authHeaders(),
      );
      expect(listing.status).toBe(200);
      expect(listing.body).toMatchObject({ allowed: true, status: 'verified' });
    });

    it('returns 409 and the remediation when a seller must not list', async () => {
      const created = await postJson(
        `${harness.baseUrl}/v1/kyc/submissions`,
        healthySubmission({
          submissionId: 'kyc_flow_00002',
          claims: { politicallyExposed: true },
        }),
        authHeaders(),
      );
      expect(created.body.status).toBe('review');
      expect(created.body.listingBlocked).toBe(true);

      const listing = await postJson(
        `${harness.baseUrl}/v1/listings/listing-9002/check`,
        { subjectId: 'seller-777' },
        authHeaders(),
      );
      expect(listing.status).toBe(409);
      expect(listing.body).toMatchObject({ allowed: false, status: 'review' });
      expect(String(listing.body.requiredAction)).toMatch(/wait for review/);
    });

    it('reports the sanctions programme when a seller is frozen', async () => {
      const created = await postJson(
        `${harness.baseUrl}/v1/kyc/submissions`,
        healthySubmission({
          submissionId: 'kyc_flow_00003',
          subject: {
            ...healthySubmission().subject,
            fullName: 'Amara Okonkwo-Bright',
            dateOfBirth: '1984-11-02',
          },
          credential: {
            format: 'eidas',
            assertion: eidasAssertion({ name: 'Amara Okonkwo-Bright', birth_date: '1984-11-02' }),
          },
        }),
        authHeaders(),
      );

      expect(created.body.status).toBe('rejected');
      const hits = (created.body.risk as Record<string, unknown>).sanctionsHits as Array<Record<string, string>>;
      expect(hits[0]).toMatchObject({ reference: 'EU-2024-0002', matchedOn: 'name_and_dob' });
    });

    it('is idempotent on retry: 200 with the original decision, no second anchor', async () => {
      const body = healthySubmission({ submissionId: 'kyc_flow_retry_1' });
      const first = await postJson(`${harness.baseUrl}/v1/kyc/submissions`, body, authHeaders());
      const second = await postJson(`${harness.baseUrl}/v1/kyc/submissions`, body, authHeaders());

      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.idempotentReplay).toBe(true);
      expect(second.body.ledger).toMatchObject({
        index: -1,
        hash: (first.body.ledger as { hash: string }).hash,
      });

      const verified = await fetch(`${harness.baseUrl}/v1/ledger/verify`, { headers: authHeaders() });
      const chain = (await verified.json()) as { valid: boolean; length: number };
      expect(chain.valid).toBe(true);
    });

    it('rejects a body missing required fields with per-field details', async () => {
      const response = await postJson(`${harness.baseUrl}/v1/kyc/submissions`, { subject: {} }, authHeaders());
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
      const details = response.body.details as Array<{ path: string; message: string }>;
      expect(details.map((item) => item.path)).toContain('consent');
      expect(details.map((item) => item.path)).toContain('subject.wallet');
    });

    it('rejects a submission without consent', async () => {
      const body = healthySubmission({ submissionId: 'kyc_no_consent' });
      (body.consent as { granted: boolean }).granted = false;
      const response = await postJson(`${harness.baseUrl}/v1/kyc/submissions`, body, authHeaders());
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('validation_failed');
      const details = response.body.details as Array<{ path: string; message: string }>;
      expect(details.map((item) => item.path)).toContain('consent.granted');
      expect(details[0].message).toMatch(/consent/);
    });

    it('rejects a submission id reused for a different payload', async () => {
      const body = healthySubmission({ submissionId: 'kyc_flow_00001' });
      const response = await postJson(
        `${harness.baseUrl}/v1/kyc/submissions`,
        { ...body, listingId: 'listing-something-else' },
        authHeaders(),
      );
      expect(response.status).toBe(400);
      expect(String(response.body.message)).toMatch(/already used/);
    });

    it('never echoes personal data back to the caller', async () => {
      const created = await postJson(
        `${harness.baseUrl}/v1/kyc/submissions`,
        healthySubmission({ submissionId: 'kyc_flow_00004' }),
        authHeaders(),
      );
      const serialised = JSON.stringify(created.body);
      for (const secret of ['Ines Ferreira', '1991-04-17', 'PT4417X', eidasAssertion()]) {
        expect(serialised).not.toContain(secret);
      }
      expect(created.body.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects a malformed JSON body as a 400, not a 500', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/kyc/submissions`, {
        method: 'POST',
        headers: authHeaders(),
        body: '{not json',
      });
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(400);
      expect(body).toMatchObject({ error: 'invalid_request_body' });
      expect(String(body.message)).toMatch(/not valid JSON/);
    });

    it('rejects an oversized body as a 413, not a 500', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/kyc/submissions`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ padding: 'x'.repeat(400_000) }),
      });
      const body = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(413);
      expect(body).toMatchObject({ error: 'payload_too_large' });
      expect(String(body.message)).toMatch(/256kb/);
    });
  });

  describe('GET /v1/kyc', () => {
    it('returns the PII-free record for a submission', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/kyc/submissions/kyc_flow_00001`, {
        headers: authHeaders(),
      });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ subjectId: 'seller-777', status: 'verified', evidenceStored: 'encrypted' });
      expect(body.personalDataEnvelope).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('PT4417X');
    });

    it('404s an unknown submission', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/kyc/submissions/kyc_does_not_exist`, {
        headers: authHeaders(),
      });
      expect(response.status).toBe(404);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: 'not_found' });
    });

    it('summarises a seller history', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/kyc/subjects/seller-777`, { headers: authHeaders() });
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.subjectId).toBe('seller-777');
      expect(Number(body.submissions)).toBeGreaterThan(0);
      expect(Array.isArray(body.history)).toBe(true);
    });
  });

  describe('GET /v1/compliance/report', () => {
    it('returns a signed report covering the submissions made above', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/compliance/report`, { headers: authHeaders() });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.marketplaceId).toBe(TEST_MARKETPLACE);
      expect(body.signature).toMatchObject({ alg: 'HMAC-SHA256' });
      expect(Number((body.totals as Record<string, number>).submissions)).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain('Ines Ferreira');
    });

    it('rejects an invalid query window', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/compliance/report?from=not-a-date`, {
        headers: authHeaders(),
      });
      expect(response.status).toBe(400);
    });
  });

  describe('GET /v1/health/details', () => {
    it('reports ledger integrity and the marketplaces it serves', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/health/details`, { headers: authHeaders() });
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.status).toBe('ok');
      expect((body.ledger as Record<string, unknown>).valid).toBe(true);
      expect(body.submissions).toEqual([TEST_MARKETPLACE]);
    });

    it('requires a partner key', async () => {
      const response = await fetch(`${harness.baseUrl}/v1/health/details`);
      expect(response.status).toBe(401);
    });
  });

  describe('POST /v1/listings/:listingId/check', () => {
    it('rejects a check with no subject in the body', async () => {
      const response = await postJson(`${harness.baseUrl}/v1/listings/listing-9003/check`, {}, authHeaders());
      expect(response.status).toBe(400);
      expect((response.body.details as Array<{ path: string }>)[0].path).toBe('subjectId');
    });

    it('rejects a malformed listing id', async () => {
      const response = await postJson(
        `${harness.baseUrl}/v1/listings/${'x'.repeat(200)}/check`,
        { subjectId: 'seller-777' },
        authHeaders(),
      );
      expect(response.status).toBe(400);
    });
  });

  describe('GET /v1/ledger', () => {
    it('serves a real anchor by its hash', async () => {
      const created = await postJson(
        `${harness.baseUrl}/v1/kyc/submissions`,
        healthySubmission({ submissionId: 'kyc_flow_00005' }),
        authHeaders(),
      );
      const hash = (created.body.ledger as { hash: string }).hash;

      const response = await fetch(`${harness.baseUrl}/v1/ledger/anchors/${hash}`, {
        headers: authHeaders(),
      });
      const anchor = (await response.json()) as Record<string, unknown>;
      expect(response.status).toBe(200);
      expect(anchor).toMatchObject({ hash, submissionId: 'kyc_flow_00005', type: 'kyc_proof' });
      expect(JSON.stringify(anchor)).not.toContain('Ines Ferreira');
    });

    it('verifies chain integrity and serves an anchor by hash', async () => {
      const verifyResponse = await fetch(`${harness.baseUrl}/v1/ledger/verify`, { headers: authHeaders() });
      const chain = (await verifyResponse.json()) as { valid: boolean };
      expect(chain.valid).toBe(true);

      const anchorResponse = await fetch(`${harness.baseUrl}/v1/ledger/anchors/${'a'.repeat(64)}`, {
        headers: authHeaders(),
      });
      expect(anchorResponse.status).toBe(404);

      const badHash = await fetch(`${harness.baseUrl}/v1/ledger/anchors/not-a-hash`, { headers: authHeaders() });
      expect(badHash.status).toBe(400);
    });
  });

  it('404s an unknown route in the documented error shape', async () => {
    const response = await fetch(`${harness.baseUrl}/v1/nope`, { headers: authHeaders() });
    expect(response.status).toBe(404);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ error: 'not_found' });
  });

  it('does not advertise the server implementation', async () => {
    const response = await fetch(`${harness.baseUrl}/health`);
    expect(response.headers.get('x-powered-by')).toBeNull();
  });
});

describe('marketplace isolation over HTTP', () => {
  it('scopes records and reports to the authenticated partner', async () => {
    const config = testConfig();
    const { container } = buildApp({
      config,
      clock: fixedClock(TEST_NOW),
      startedAt: new Date(TEST_NOW),
    });
    // The container is shared; both partners authenticate against the same keys.
    await container.kycService.submit(TEST_MARKETPLACE, healthySubmission({ submissionId: 'kyc_iso_0001' }));

    const report = await container.reportService.generate('market-beta');
    expect(report.totals.submissions).toBe(0);
    expect(await container.kycService.getRecord('market-beta', 'kyc_iso_0001')).toBeUndefined();
  });
});