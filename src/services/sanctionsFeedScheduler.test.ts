import {
  SanctionsFeedScheduler,
  createSanctionsFeedScheduler,
  loadInitialSanctionsFeed,
  type SanctionsFeedSchedulerOptions,
} from './sanctionsFeedScheduler';
import { RiskEngine } from '../risk/engine';
import type { SanctionsEntry } from '../risk/referenceData';
import type { SanctionsFeed } from '../risk/sanctions';
import { fixedClock } from '../util/clock';

const URL = 'https://example.test/sanctions.json';

const ENTRY: SanctionsEntry = {
  reference: 'EU-FEED-1',
  // Deliberately absent from the seeded EU list, so a hot-swap test can prove
  // the refreshed list — not the seed — is what screens the subject.
  name: 'Katya Belova Sorokin',
  dateOfBirth: '1968-11-30',
  programme: 'EU 833/2014 — asset freezes',
  listName: 'eu-consolidated',
};

const SILENT_LOGGER = { info: () => {}, warn: () => {}, error: () => {} };

/** Minimal Response stand-in accepted by `readLimitedJson`. */
function mockResponse(body: unknown): Response {
  const json = JSON.stringify(body);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(json));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-length': String(json.length) }),
    body: stream,
  } as unknown as Response;
}

interface FetchScript {
  impl: typeof fetch;
  calls: number;
}

/** A fetch stub that serves `responses` in order; the last one repeats. */
function scriptedFetch(responses: Array<() => Promise<Response>>): FetchScript {
  const state: FetchScript = {
    calls: 0,
    impl: (async () => {
      const index = Math.min(state.calls, responses.length - 1);
      state.calls += 1;
      return responses[index]();
    }) as unknown as typeof fetch,
  };
  return state;
}

const alwaysFails = (message = 'Failed to fetch sanctions feed: 503 Service Unavailable') =>
  scriptedFetch([
    async () => {
      throw new Error(message);
    },
  ]);

interface Harness {
  scheduler: SanctionsFeedScheduler;
  fetch: FetchScript;
  installed: SanctionsFeed[];
  sleeps: number[];
}

function buildHarness(
  responses: Array<() => Promise<Response>>,
  overrides: Partial<SanctionsFeedSchedulerOptions> = {},
): Harness {
  const fetchStub = scriptedFetch(responses);
  const installed: SanctionsFeed[] = [];
  const sleeps: number[] = [];
  const scheduler = new SanctionsFeedScheduler(
    {
      url: URL,
      logger: SILENT_LOGGER,
      clock: fixedClock('2025-03-01T09:00:00.000Z'),
      // Equal jitter collapses to the full cap at random() === 1, so the
      // recorded sleeps are exactly the exponential caps.
      random: () => 1,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      feedOptions: { fetchImpl: fetchStub.impl },
      ...overrides,
    },
    (feed) => {
      installed.push(feed);
    },
  );
  return { scheduler, fetch: fetchStub, installed, sleeps };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('SanctionsFeedScheduler', () => {
  describe('wiring guards', () => {
    it('does not start without a feed URL and reports itself disabled', () => {
      const scheduler = new SanctionsFeedScheduler({ url: null, logger: SILENT_LOGGER });

      scheduler.start();

      const metrics = scheduler.getMetrics();
      expect(metrics.enabled).toBe(false);
      expect(metrics.lastRefreshStatus).toBe('never');
      expect(metrics.nextRefreshAt).toBeNull();
      scheduler.stop();
    });

    it('refuses a manual refresh without a feed URL', async () => {
      const scheduler = new SanctionsFeedScheduler({ url: null, logger: SILENT_LOGGER });
      await expect(scheduler.triggerRefresh()).resolves.toBeNull();
    });
  });

  describe('scheduled refresh', () => {
    it('fetches immediately on start and installs the feed', async () => {
      const harness = buildHarness([async () => mockResponse({ listName: 'eu-consolidated', entries: [ENTRY] })], {
        intervalMs: 60_000,
      });

      harness.scheduler.start();
      await harness.scheduler.triggerRefresh(); // deterministic: drive one cycle directly
      harness.scheduler.stop();

      expect(harness.fetch.calls).toBeGreaterThanOrEqual(1);
      expect(harness.installed).toHaveLength(1);
      expect(harness.installed[0].entries[0].reference).toBe('EU-FEED-1');
    });

    it('records success metrics and clears the previous error', async () => {
      const harness = buildHarness([async () => mockResponse({ entries: [ENTRY] })], {
        intervalMs: 60_000,
      });

      await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      expect(harness.scheduler.getMetrics()).toMatchObject({
        enabled: true,
        lastRefreshStatus: 'success',
        lastError: null,
        consecutiveFailures: 0,
        totalRefreshes: 1,
        totalFailures: 0,
        circuitBreakerState: 'closed',
        installedEntries: 1,
      });
    });

    it('exposes the next scheduled attempt on the metrics', async () => {
      jest.useFakeTimers();
      const harness = buildHarness([async () => mockResponse({ entries: [ENTRY] })], {
        intervalMs: 60_000,
      });

      harness.scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(harness.scheduler.getMetrics().nextRefreshAt).toBe('2025-03-01T09:01:00.000Z');

      harness.scheduler.stop();
      expect(harness.scheduler.getMetrics().nextRefreshAt).toBeNull();
    });

    it('stops fetching once stopped', async () => {
      jest.useFakeTimers();
      const harness = buildHarness([async () => mockResponse({ entries: [ENTRY] })], {
        intervalMs: 1_000,
      });

      harness.scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      const callsAfterStart = harness.fetch.calls;
      harness.scheduler.stop();
      await jest.advanceTimersByTimeAsync(60_000);

      expect(callsAfterStart).toBe(1);
      expect(harness.fetch.calls).toBe(1);
    });
  });

  describe('boot feed', () => {
    it('does not re-fetch immediately when a boot feed is already installed', async () => {
      jest.useFakeTimers();
      const harness = buildHarness([async () => mockResponse({ entries: [ENTRY] })], {
        intervalMs: 60_000,
        initialFeed: { listName: 'eu-consolidated', entries: [ENTRY, ENTRY] },
      });

      harness.scheduler.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(harness.fetch.calls).toBe(0);
      expect(harness.scheduler.getMetrics().installedEntries).toBe(2);

      await jest.advanceTimersByTimeAsync(60_000);
      expect(harness.fetch.calls).toBe(1);
      harness.scheduler.stop();
    });

    it('starts with no installed list when no boot feed was supplied', () => {
      const harness = buildHarness([async () => mockResponse({ entries: [ENTRY] })], {
        intervalMs: 60_000,
      });

      expect(harness.scheduler.getMetrics().installedEntries).toBeNull();
    });
  });

  describe('retries and backoff', () => {
    it('retries a failing feed with exponential backoff and then succeeds', async () => {
      const harness = buildHarness(
        [
          async () => {
            throw new Error('upstream 503');
          },
          async () => {
            throw new Error('upstream 503');
          },
          async () => mockResponse({ entries: [ENTRY] }),
        ],
        { maxRetries: 3, baseRetryDelayMs: 1_000, maxRetryDelayMs: 60_000 },
      );

      const feed = await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      expect(feed?.entries).toHaveLength(1);
      expect(harness.fetch.calls).toBe(3);
      expect(harness.sleeps).toEqual([1_000, 2_000]);
      expect(harness.installed).toHaveLength(1);
      expect(harness.scheduler.getMetrics()).toMatchObject({
        lastRefreshStatus: 'success',
        totalFailures: 0,
        consecutiveFailures: 0,
      });
    });

    it('caps the exponential backoff at the configured maximum', async () => {
      const harness = buildHarness([async () => { throw new Error('down'); }], {
        maxRetries: 4,
        baseRetryDelayMs: 1_000,
        maxRetryDelayMs: 2_500,
      });

      await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      expect(harness.sleeps).toEqual([1_000, 2_000, 2_500, 2_500]);
    });

    it('keeps the previous list and records the error when every attempt fails', async () => {
      const harness = buildHarness([async () => { throw new Error('upstream 500'); }], {
        maxRetries: 1,
        baseRetryDelayMs: 10,
      });

      const feed = await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      expect(feed).toBeNull();
      expect(harness.installed).toHaveLength(0);
      expect(harness.fetch.calls).toBe(2);
      expect(harness.scheduler.getMetrics()).toMatchObject({
        lastRefreshStatus: 'failed',
        lastError: 'upstream 500',
        consecutiveFailures: 1,
        totalFailures: 1,
        totalRefreshes: 1,
      });
    });

    it('spreads retries with jitter so replicas do not synchronise', async () => {
      const delays: number[] = [];
      const scheduler = new SanctionsFeedScheduler(
        {
          url: URL,
          maxRetries: 1,
          baseRetryDelayMs: 1_000,
          maxRetryDelayMs: 60_000,
          logger: SILENT_LOGGER,
          random: () => 0,
          sleep: async (ms: number) => {
            delays.push(ms);
          },
          feedOptions: { fetchImpl: alwaysFails().impl },
        },
      );

      await scheduler.triggerRefresh();
      scheduler.stop();

      // Equal jitter: the wait is at least half the cap, at most the cap.
      expect(delays).toEqual([500]);
    });
  });

  describe('degenerate feed protection', () => {
    it('refuses to install an empty feed — screening must never silently stop', async () => {
      const harness = buildHarness([async () => mockResponse({ entries: [] })], {
        maxRetries: 0,
        intervalMs: 60_000,
      });

      const feed = await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      expect(feed).toBeNull();
      expect(harness.installed).toHaveLength(0);
      expect(harness.scheduler.getMetrics()).toMatchObject({ lastRefreshStatus: 'failed' });
      expect(harness.scheduler.getMetrics().lastError).toMatch(/refusing to replace/i);
    });

    it('refuses a feed whose every row was dropped as malformed', async () => {
      const harness = buildHarness(
        [async () => mockResponse({ entries: [{ name: 'no reference or programme' }] })],
        { maxRetries: 0 },
      );

      await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      expect(harness.installed).toHaveLength(0);
      expect(harness.scheduler.getMetrics().lastError).toMatch(/refusing to replace/i);
    });

    it('retries a degenerate feed instead of accepting it on the first response', async () => {
      const harness = buildHarness(
        [
          async () => mockResponse({ entries: [] }),
          async () => mockResponse({ entries: [ENTRY] }),
        ],
        { maxRetries: 2, baseRetryDelayMs: 5 },
      );

      const feed = await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      expect(feed?.entries).toHaveLength(1);
      expect(harness.fetch.calls).toBe(2);
      expect(harness.installed).toHaveLength(1);
    });

    it('honours a configured minimum entry count', async () => {
      const harness = buildHarness([async () => mockResponse({ entries: [ENTRY] })], {
        minEntries: 5,
        maxRetries: 0,
      });

      await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      expect(harness.installed).toHaveLength(0);
      expect(harness.scheduler.getMetrics().lastError).toMatch(/minimum 5/);
    });
  });

  describe('circuit breaker', () => {
    // No injected clock here: jest's fake timers also fake `Date`, so the breaker's
    // reset window and the scheduler's real timers advance together.
    const breakerConfig = {
      clock: undefined,
      intervalMs: 100,
      maxRetries: 0,
      circuitBreakerThreshold: 2,
      circuitBreakerResetTimeoutMs: 1_000,
      baseRetryDelayMs: 1,
    };

    it('opens after consecutive failures and suppresses scheduled attempts', async () => {
      jest.useFakeTimers();
      const harness = buildHarness([async () => { throw new Error('upstream 503'); }], breakerConfig);

      harness.scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(100);

      const metrics = harness.scheduler.getMetrics();
      expect(metrics.consecutiveFailures).toBe(2);
      expect(metrics.circuitBreakerState).toBe('open');
      expect(metrics.circuitBreakerNextAttemptAt).not.toBeNull();
      expect(harness.fetch.calls).toBe(2);

      // Still open: the interval elapsing must not produce upstream traffic.
      await jest.advanceTimersByTimeAsync(500);
      expect(harness.fetch.calls).toBe(2);
      harness.scheduler.stop();
    });

    it('half-opens after the reset timeout and closes again when the feed recovers', async () => {
      jest.useFakeTimers();
      let recover = false;
      const harness = buildHarness(
        [
          async () => {
            if (recover) return mockResponse({ entries: [ENTRY] });
            throw new Error('upstream 503');
          },
        ],
        breakerConfig,
      );

      harness.scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(100);
      expect(harness.scheduler.getMetrics().circuitBreakerState).toBe('open');

      recover = true;
      await jest.advanceTimersByTimeAsync(1_000);
      await jest.advanceTimersByTimeAsync(1);

      const metrics = harness.scheduler.getMetrics();
      expect(harness.fetch.calls).toBe(3);
      expect(metrics.circuitBreakerState).toBe('closed');
      expect(metrics.circuitBreakerOpenedAt).toBeNull();
      expect(metrics.circuitBreakerNextAttemptAt).toBeNull();
      expect(metrics.consecutiveFailures).toBe(0);
      expect(metrics.lastRefreshStatus).toBe('success');
      expect(harness.installed).toHaveLength(1);
      harness.scheduler.stop();
    });

    it('re-opens when the half-open probe fails', async () => {
      jest.useFakeTimers();
      const harness = buildHarness([async () => { throw new Error('still down'); }], breakerConfig);

      harness.scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(100);
      expect(harness.scheduler.getMetrics().circuitBreakerState).toBe('open');

      await jest.advanceTimersByTimeAsync(1_000);
      await jest.advanceTimersByTimeAsync(1);

      const metrics = harness.scheduler.getMetrics();
      expect(metrics.circuitBreakerState).toBe('open');
      expect(metrics.totalFailures).toBe(3);
      harness.scheduler.stop();
    });

    it('lets an operator trigger a refresh through an open breaker', async () => {
      const harness = buildHarness(
        [
          async () => {
            throw new Error('upstream 503');
          },
          async () => mockResponse({ entries: [ENTRY] }),
        ],
        { maxRetries: 0, circuitBreakerThreshold: 1 },
      );

      await harness.scheduler.triggerRefresh();
      expect(harness.scheduler.getMetrics().circuitBreakerState).toBe('open');
      expect(harness.installed).toHaveLength(0);

      const feed = await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      expect(feed?.entries).toHaveLength(1);
      expect(harness.scheduler.getMetrics().circuitBreakerState).toBe('closed');
    });
  });

  describe('shutdown and concurrency', () => {
    it('aborts an in-flight backoff wait when stopped, so shutdown is prompt', async () => {
      jest.useFakeTimers();
      const harness = buildHarness(
        [async () => { throw new Error('upstream 503'); }],
        { maxRetries: 3, baseRetryDelayMs: 5 * 60_000, sleep: undefined },
      );

      const pending = harness.scheduler.triggerRefresh();
      await jest.advanceTimersByTimeAsync(0);
      harness.scheduler.stop();

      await expect(pending).resolves.toBeNull();
      // A deliberate shutdown is not an upstream failure: it must not push the
      // breaker towards opening.
      expect(harness.scheduler.getMetrics()).toMatchObject({
        consecutiveFailures: 0,
        circuitBreakerState: 'closed',
      });
      expect(harness.fetch.calls).toBe(1);
    });

    it('leaves no pending timer behind after a stop', async () => {
      jest.useFakeTimers();
      const harness = buildHarness([async () => mockResponse({ entries: [ENTRY] })], {
        intervalMs: 1_000,
      });

      harness.scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(1);
      harness.scheduler.stop();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('never holds the process open: scheduled timers are unref-ed', () => {
      const handles: Array<{ hasRef?: () => boolean }> = [];
      const realSetTimeout = globalThis.setTimeout;
      jest.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        const handle = realSetTimeout(fn, ms) as unknown as { hasRef?: () => boolean };
        handles.push(handle);
        return handle;
      }) as unknown as typeof globalThis.setTimeout);

      const harness = buildHarness([async () => mockResponse({ entries: [ENTRY] })], {
        intervalMs: 60_000,
      });
      harness.scheduler.start();
      harness.scheduler.stop();

      expect(handles.length).toBeGreaterThan(0);
      expect(handles.every((handle) => handle.hasRef?.() === false)).toBe(true);
    });

    it('collapses concurrent refreshes into a single upstream fetch', async () => {
      const harness = buildHarness([async () => mockResponse({ entries: [ENTRY] })], {
        intervalMs: 60_000,
      });

      const [first, second] = await Promise.all([
        harness.scheduler.triggerRefresh(),
        harness.scheduler.triggerRefresh(),
      ]);
      harness.scheduler.stop();

      expect(harness.fetch.calls).toBe(1);
      expect(first?.entries).toHaveLength(1);
      expect(second?.entries).toHaveLength(1);
      expect(harness.installed).toHaveLength(1);
    });

    it('restarts cleanly after a stop', async () => {
      jest.useFakeTimers();
      const harness = buildHarness([async () => { throw new Error('upstream 503'); }], {
        intervalMs: 100,
        maxRetries: 0,
        circuitBreakerThreshold: 1,
      });

      harness.scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      expect(harness.scheduler.getMetrics().circuitBreakerState).toBe('open');
      harness.scheduler.stop();

      harness.scheduler.start();
      const metrics = harness.scheduler.getMetrics();
      expect(metrics.circuitBreakerState).toBe('closed');
      expect(metrics.consecutiveFailures).toBe(0);
      await jest.advanceTimersByTimeAsync(0);
      expect(harness.fetch.calls).toBe(2);
      harness.scheduler.stop();
    });

    it('is idempotent: a second start neither double-schedules nor resets state', async () => {
      jest.useFakeTimers();
      const harness = buildHarness([async () => { throw new Error('upstream 503'); }], {
        intervalMs: 100,
        maxRetries: 0,
        circuitBreakerThreshold: 5,
      });

      harness.scheduler.start();
      await jest.advanceTimersByTimeAsync(0);
      const afterFirst = harness.scheduler.getMetrics();

      harness.scheduler.start();
      expect(harness.scheduler.getMetrics()).toEqual(afterFirst);

      await jest.advanceTimersByTimeAsync(0);
      expect(harness.fetch.calls).toBe(1);
      expect(harness.scheduler.getMetrics().consecutiveFailures).toBe(1);
      harness.scheduler.stop();
    });

    it('keeps a control character out of the last error it publishes', async () => {
      const harness = buildHarness(
        [async () => { throw new Error(`upstream\u0007 forged`); }],
        { maxRetries: 0 },
      );

      await harness.scheduler.triggerRefresh();
      harness.scheduler.stop();

      const { lastError } = harness.scheduler.getMetrics();
      expect(lastError).toBe('upstream  forged');
    });
  });

  describe('boot feed (loadInitialSanctionsFeed)', () => {
    it('returns the live feed when it is usable', async () => {
      const errors: string[] = [];
      const feed = await loadInitialSanctionsFeed({
        url: URL,
        minEntries: 1,
        logger: { info: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
        feedOptions: { fetchImpl: (async () => mockResponse({ listName: 'eu-consolidated', entries: [ENTRY] })) as unknown as typeof fetch },
      });

      expect(feed?.entries).toHaveLength(1);
      expect(errors).toEqual([]);
    });

    it('skips the fetch entirely when no URL is configured', async () => {
      const fetchImpl = jest.fn();
      await expect(loadInitialSanctionsFeed({ url: null, minEntries: 1, feedOptions: { fetchImpl: fetchImpl as unknown as typeof fetch } }))
        .resolves.toBeUndefined();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('falls back to the seeded list when the feed is too small', async () => {
      // The hole this guards: an upstream `[]` must not become the live list.
      const errors: string[] = [];
      const feed = await loadInitialSanctionsFeed({
        url: URL,
        minEntries: 1,
        logger: { info: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
        feedOptions: { fetchImpl: (async () => mockResponse({ entries: [] })) as unknown as typeof fetch },
      });

      expect(feed).toBeUndefined();
      expect(errors.join(' ')).toMatch(/below the minimum 1/);
    });

    it('falls back to the seeded list when the feed is unreachable', async () => {
      const errors: string[] = [];
      const feed = await loadInitialSanctionsFeed({
        url: URL,
        minEntries: 1,
        logger: { info: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
        feedOptions: { fetchImpl: alwaysFails().impl },
      });

      expect(feed).toBeUndefined();
      expect(errors.join(' ')).toMatch(/using seeded list/);
    });

    it('strips control characters from remote text before it reaches a log line', async () => {
      const errors: string[] = [];
      const forged = `evil${String.fromCharCode(10)}[nft-kyc-hub] fake log line`;
      await loadInitialSanctionsFeed({
        url: URL,
        minEntries: 1,
        logger: { info: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
        feedOptions: { fetchImpl: alwaysFails(forged).impl },
      });

      expect(errors.join(' ')).not.toContain(String.fromCharCode(10));
      expect(errors.join(' ')).toMatch(/evil \[nft-kyc-hub\] fake log line/);
    });
  });

  describe('risk engine hot-swap', () => {
    const engineInput = {
      subjectId: 'seller-777',
      fullName: ENTRY.name,
      dateOfBirth: ENTRY.dateOfBirth as string,
      countryCode: 'PT',
      documentType: 'passport',
      documentExpiresOn: '2031-04-16',
      wallet: {
        address: '0x' + '1'.repeat(40),
        firstSeenAt: '2021-06-01T00:00:00.000Z',
        transactionCount: 412,
        volumeUsd: 48_000,
      },
      claims: { politicallyExposed: false, sourceOfFunds: 'salary' },
      identity: {
        verified: true as const,
        provider: 'eidas-gateway',
        assertion: {
          subjectId: 'seller-777',
          fullName: ENTRY.name,
          dateOfBirth: ENTRY.dateOfBirth as string,
          assurance: 'high' as const,
          method: 'eidas-aalink-high',
          issuer: 'https://eidas-gateway.demo/issuer',
          issuedAt: '2025-02-28T10:00:00.000Z',
          expiresAt: '2026-02-28T10:00:00.000Z',
          claims: {},
        },
      },
      consentGranted: true,
      now: new Date('2025-03-01T09:00:00.000Z'),
    };

    it('keeps screening the previous list when a refresh fails', async () => {
      const riskEngine = new RiskEngine();
      const before = riskEngine.assess(engineInput);
      expect(before.decision).toBe('approve');

      const harness = buildHarness([async () => { throw new Error('upstream 503'); }], {
        maxRetries: 0,
      });
      const { scheduler } = createSanctionsFeedScheduler(riskEngine, {
        url: URL,
        maxRetries: 0,
        logger: SILENT_LOGGER,
        feedOptions: { fetchImpl: harness.fetch.impl },
      });

      await scheduler.triggerRefresh();
      scheduler.stop();

      const after = riskEngine.assess(engineInput);
      expect(after.decision).toBe('approve');
      expect(after.sanctionsHits).toHaveLength(0);
    });

    it('rejects the subject once the refreshed list contains them', async () => {
      const riskEngine = new RiskEngine();
      const harness = buildHarness([
        async () => mockResponse({ listName: 'eu-consolidated', entries: [ENTRY] }),
      ]);
      const { scheduler } = createSanctionsFeedScheduler(riskEngine, {
        url: URL,
        logger: SILENT_LOGGER,
        feedOptions: { fetchImpl: harness.fetch.impl },
      });

      await scheduler.triggerRefresh();
      scheduler.stop();

      const after = riskEngine.assess(engineInput);
      expect(after.decision).toBe('reject');
      expect(after.sanctionsHits).toHaveLength(1);
      expect(after.sanctionsHits[0].reference).toBe('EU-FEED-1');
    });
  });
});
