import {
  isFeedUsable,
  loadSanctionsFeed,
  type SanctionsFeed,
  type LoadSanctionsFeedOptions,
} from '../risk/sanctions';
import { RiskEngine } from '../risk/engine';
import { systemClock, type Clock } from '../util/clock';

export interface SanctionsFeedSchedulerOptions {
  /** URL to fetch the sanctions feed from. Required if enabled. */
  url: string | null;
  /** Refresh interval in milliseconds. Default: 24 hours (86400000). */
  intervalMs?: number;
  /** Maximum number of retry attempts on failure. Default: 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff in milliseconds. Default: 5000 (5s). */
  baseRetryDelayMs?: number;
  /** Maximum delay for exponential backoff in milliseconds. Default: 300000 (5min). */
  maxRetryDelayMs?: number;
  /** Options passed to loadSanctionsFeed (timeout, size limit). */
  feedOptions?: LoadSanctionsFeedOptions;
  /** Logger for info/warn/error. Defaults to console. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Clock for time operations (mainly for testing). */
  clock?: Clock;
  /** Circuit breaker: open after this many consecutive failures. Default: 5. */
  circuitBreakerThreshold?: number;
  /** Circuit breaker: time in ms before attempting to close (half-open). Default: 10 minutes. */
  circuitBreakerResetTimeoutMs?: number;
  /**
   * Refuse to install a feed with fewer than this many entries. Default: 1.
   *
   * An upstream outage that returns `[]` — or a schema change that makes every
   * row fail validation — would otherwise install an *empty* sanctions list and
   * silently stop screening every subsequent submission. A rejected feed keeps
   * the last known-good list in place and counts as a failure.
   */
  minEntries?: number;
  /** Jitter source for the backoff. Default: `Math.random`. */
  random?: () => number;
  /** Backoff sleep seam. Default: a timer that resolves early when stopped. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * A feed that was already loaded and installed before the scheduler started
   * (the boot fetch). When present, the scheduler treats it as the current list
   * and waits a full interval before its first refresh instead of re-fetching
   * the same bytes seconds later.
   */
  initialFeed?: SanctionsFeed;
}

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

/** The subset of metrics safe to expose on the unauthenticated `/health` probe. */
export type SchedulerSummary = Pick<
  SchedulerMetrics,
  | 'enabled'
  | 'lastRefreshStatus'
  | 'lastRefreshAt'
  | 'consecutiveFailures'
  | 'circuitBreakerState'
  | 'totalRefreshes'
  | 'totalFailures'
  | 'installedEntries'
  | 'minEntries'
>;

/**
 * Project metrics for `/health`. Deliberately omits `url` and `lastError`:
 * the liveness probe is unauthenticated, and neither the feed location nor an
 * upstream error string belongs on a public surface. The full set is available
 * on the authenticated `/v1/health/details`.
 */
export function toSchedulerSummary(metrics?: SchedulerMetrics): SchedulerSummary | null {
  if (!metrics) return null;
  return {
    enabled: metrics.enabled,
    lastRefreshStatus: metrics.lastRefreshStatus,
    lastRefreshAt: metrics.lastRefreshAt,
    consecutiveFailures: metrics.consecutiveFailures,
    circuitBreakerState: metrics.circuitBreakerState,
    totalRefreshes: metrics.totalRefreshes,
    totalFailures: metrics.totalFailures,
    installedEntries: metrics.installedEntries,
    minEntries: metrics.minEntries,
  };
}

export interface SchedulerMetrics {
  enabled: boolean;
  url: string | null;
  intervalMs: number;
  lastRefreshAt: string | null;
  lastRefreshStatus: 'success' | 'failed' | 'never';
  lastError: string | null;
  consecutiveFailures: number;
  nextRefreshAt: string | null;
  totalRefreshes: number;
  totalFailures: number;
  circuitBreakerState: CircuitBreakerState;
  circuitBreakerOpenedAt: string | null;
  circuitBreakerNextAttemptAt: string | null;
  /** Entries currently installed in the screener; null until the first install. */
  installedEntries: number | null;
  /** Minimum entry count a feed must have to be installed. */
  minEntries: number;
}

type RefreshCallback = (feed: SanctionsFeed) => void;
type TimerHandle = ReturnType<typeof setTimeout>;

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_DELAY_MS = 5_000; // 5 seconds
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
const DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MIN_ENTRIES = 1;

const ABORTED_MESSAGE = 'Refresh aborted: scheduler stopped';

/**
 * Keeps the live sanctions feed fresh instead of loading it once at boot.
 *
 * Failure handling is the point of this class, because an upstream reference
 * feed is the one dependency a KYC pipeline cannot do without:
 *
 * - **Retries with jittered exponential backoff** — transient upstream errors
 *   recover on their own, and equal jitter stops every replica from retrying in
 *   lockstep.
 * - **Circuit breaker** — a sustained outage stops the request traffic after
 *   `circuitBreakerThreshold` failed refreshes and probes once per reset window
 *   instead, so a dead endpoint cannot be hammered.
 * - **Never install a degenerate feed** — a feed with too few entries is
 *   treated as a failure, leaving the previous list screening live.
 * - **Prompt shutdown** — `stop()` cancels the pending timer *and* interrupts an
 *   in-flight backoff wait, and every timer is unref-ed so a scheduler can
 *   never hold the process open.
 * - **Single-flight** — overlapping scheduled and operator-triggered refreshes
 *   share one fetch, so a slow response cannot overwrite a newer list.
 */
export class SanctionsFeedScheduler {
  private readonly url: string | null;
  private readonly intervalMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly feedOptions: LoadSanctionsFeedOptions;
  private readonly logger: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly clock: Clock;
  private readonly onRefresh: RefreshCallback | null;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerResetTimeoutMs: number;
  private readonly minEntries: number;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Resolvers for in-flight backoff waits, so `stop()` can cut them short. */
  private readonly pendingSleeps = new Set<() => void>();

  private timer: TimerHandle | null = null;
  private inFlight: Promise<SanctionsFeed | null> | null = null;
  private lastRefreshAt: Date | null = null;
  private lastRefreshStatus: SchedulerMetrics['lastRefreshStatus'] = 'never';
  private lastError: string | null = null;
  private consecutiveFailures = 0;
  private totalRefreshes = 0;
  private totalFailures = 0;
  private installedEntries: number | null = null;
  /** True while the list installed at boot is still the freshest one we have. */
  private awaitingFirstRefresh = false;
  private nextRefreshAt: Date | null = null;
  private stopped = false;

  // Circuit breaker state
  private circuitBreakerState: CircuitBreakerState = 'closed';
  private circuitBreakerOpenedAt: Date | null = null;
  private circuitBreakerNextAttemptAt: Date | null = null;

  constructor(options: SanctionsFeedSchedulerOptions, onRefresh?: RefreshCallback) {
    this.url = options.url;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? DEFAULT_BASE_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.feedOptions = options.feedOptions ?? {};
    this.logger = options.logger ?? console;
    this.clock = options.clock ?? systemClock;
    this.onRefresh = onRefresh ?? null;
    this.circuitBreakerThreshold = options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.circuitBreakerResetTimeoutMs = options.circuitBreakerResetTimeoutMs ?? DEFAULT_CIRCUIT_BREAKER_RESET_TIMEOUT_MS;
    this.minEntries = options.minEntries ?? DEFAULT_MIN_ENTRIES;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((ms: number) => this.abortableSleep(ms));
    if (options.initialFeed) {
      this.installedEntries = options.initialFeed.entries.length;
      this.awaitingFirstRefresh = true;
    }
  }

  /**
   * Start the scheduler. If already running, this is a no-op.
   *
   * The first refresh runs immediately, then on the configured interval — unless
   * an `initialFeed` was supplied, in which case that boot list is still fresh
   * and the first refresh waits a full interval.
   */
  start(): void {
    if (!this.url) {
      this.logger.info('[sanctions-scheduler] No feed URL configured; scheduler not started');
      return;
    }
    if (this.timer !== null) {
      return;
    }
    this.stopped = false;
    // A restart is a deliberate operator action: start from a clean slate rather
    // than inheriting the failure streak that was open when we shut down.
    this.circuitBreakerState = 'closed';
    this.circuitBreakerOpenedAt = null;
    this.circuitBreakerNextAttemptAt = null;
    this.consecutiveFailures = 0;
    const firstDelay = this.awaitingFirstRefresh ? this.intervalMs : 0;
    this.logger.info(
      `[sanctions-scheduler] Starting with interval ${this.intervalMs}ms` +
        (this.awaitingFirstRefresh ? ' (boot feed still fresh, first refresh after one interval)' : ''),
    );
    this.scheduleNext(firstDelay);
  }

  /** Stop the scheduler, cancel the pending timer and interrupt any backoff wait. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRefreshAt = null;
    for (const wake of this.pendingSleeps) {
      wake();
    }
    this.pendingSleeps.clear();
    this.logger.info('[sanctions-scheduler] Stopped');
  }

  /**
   * Run a refresh now, outside the schedule. This is the operator escape hatch
   * and the entry point for an EventBridge-invoked Lambda: it bypasses the
   * circuit breaker so a fixed upstream can be recovered without a restart.
   */
  async triggerRefresh(): Promise<SanctionsFeed | null> {
    if (!this.url) {
      this.logger.warn('[sanctions-scheduler] Cannot trigger refresh: no feed URL configured');
      return null;
    }
    return this.doRefresh(true);
  }

  /** Get current scheduler metrics for health/observability. */
  getMetrics(): SchedulerMetrics {
    return {
      enabled: !!this.url,
      url: this.url,
      intervalMs: this.intervalMs,
      lastRefreshAt: this.lastRefreshAt?.toISOString() ?? null,
      lastRefreshStatus: this.lastRefreshStatus,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      nextRefreshAt: this.nextRefreshAt?.toISOString() ?? null,
      totalRefreshes: this.totalRefreshes,
      totalFailures: this.totalFailures,
      circuitBreakerState: this.circuitBreakerState,
      circuitBreakerOpenedAt: this.circuitBreakerOpenedAt?.toISOString() ?? null,
      circuitBreakerNextAttemptAt: this.circuitBreakerNextAttemptAt?.toISOString() ?? null,
      installedEntries: this.installedEntries,
      minEntries: this.minEntries,
    };
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped || !this.url) return;

    if (this.circuitBreakerState === 'open') {
      if (!this.tryHalfOpen()) {
        const waitMs = this.circuitBreakerNextAttemptAt
          ? Math.max(0, this.circuitBreakerNextAttemptAt.getTime() - this.clock.now().getTime())
          : this.circuitBreakerResetTimeoutMs;
        this.nextRefreshAt = this.circuitBreakerNextAttemptAt
          ?? new Date(this.clock.now().getTime() + waitMs);
        this.logger.info(`[sanctions-scheduler] Circuit breaker open, next probe in ${waitMs}ms`);
        this.timer = this.setTimer(() => {
          this.timer = null;
          if (!this.stopped) this.scheduleNext(0);
        }, waitMs);
        return;
      }
    }

    this.nextRefreshAt = new Date(this.clock.now().getTime() + Math.max(0, delayMs));
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.stopped) return;
      void this.doRefresh()
        .catch((error: unknown) => {
          // doRefresh swallows its own errors; this guard exists so a defect in
          // the retry bookkeeping can never become an unhandled rejection.
          this.logger.error(
            `[sanctions-scheduler] Unexpected refresh failure: ${sanitize(describe(error))}`,
          );
        })
        .finally(() => {
          if (!this.stopped) this.scheduleNext(this.intervalMs);
        });
    }, delayMs);
  }

  /** Transition an expired open breaker to half-open. Returns false while still open. */
  private tryHalfOpen(): boolean {
    const now = this.clock.now();
    if (this.circuitBreakerNextAttemptAt && now >= this.circuitBreakerNextAttemptAt) {
      this.circuitBreakerState = 'half-open';
      this.logger.info('[sanctions-scheduler] Circuit breaker half-open: allowing one test request');
      return true;
    }
    return false;
  }

  private doRefresh(bypassCircuitBreaker = false): Promise<SanctionsFeed | null> {
    // Single-flight: a scheduled and an operator-triggered refresh must not race,
    // or a slow response could install a stale list over a newer one.
    if (this.inFlight) return this.inFlight;
    const run = this.runRefresh(bypassCircuitBreaker).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async runRefresh(bypassCircuitBreaker: boolean): Promise<SanctionsFeed | null> {
    if (!this.url) return null;

    if (!bypassCircuitBreaker && this.circuitBreakerState === 'open' && !this.tryHalfOpen()) {
      this.logger.warn('[sanctions-scheduler] Circuit breaker open: skipping refresh');
      return null;
    }

    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      if (this.stopped) {
        this.recordAbortedRefresh();
        return null;
      }
      try {
        this.logger.info(
          `[sanctions-scheduler] Fetching sanctions feed (attempt ${attempt + 1}/${this.maxRetries + 1})`,
        );
        const feed = await loadSanctionsFeed(this.url, this.feedOptions);
        if (this.stopped) {
          this.recordAbortedRefresh();
          return null;
        }
        // A degenerate feed is a failed *attempt*, not a failed refresh: it is
        // retried like a fetch error, but it can never reach the screener.
        if (!isFeedUsable(feed, this.minEntries)) {
          throw new Error(
            `Sanctions feed returned ${feed.entries.length} entries, refusing to replace the active list (minimum ${this.minEntries})`,
          );
        }
        this.commit(feed);
        return feed;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`[sanctions-scheduler] Feed fetch failed: ${sanitize(lastError.message)}`);
        attempt += 1;
        if (this.stopped) {
          this.recordAbortedRefresh();
          return null;
        }
        if (attempt <= this.maxRetries) {
          const delay = this.backoffDelay(attempt);
          this.logger.info(`[sanctions-scheduler] Retrying in ${delay}ms`);
          await this.sleep(delay);
        }
      }
    }

    this.recordFailedRefresh(lastError?.message ?? 'Unknown error');
    return null;
  }

  /** Install a validated feed and record the successful refresh. */
  private commit(feed: SanctionsFeed): void {
    if (this.onRefresh) {
      this.onRefresh(feed);
    }
    this.installedEntries = feed.entries.length;
    this.awaitingFirstRefresh = false;
    this.lastRefreshAt = this.clock.now();
    this.lastRefreshStatus = 'success';
    this.lastError = null;
    this.consecutiveFailures = 0;
    this.totalRefreshes += 1;
    this.closeCircuitBreaker();
    this.logger.info(
      `[sanctions-scheduler] Feed refreshed: ${feed.entries.length} entries, list="${sanitize(feed.listName ?? 'unknown')}"`,
    );
  }

  /** Equal jitter: half the cap to the full cap, so retries never synchronise. */
  private backoffDelay(failureCount: number): number {
    const cap = Math.min(this.baseRetryDelayMs * 2 ** (failureCount - 1), this.maxRetryDelayMs);
    const factor = 0.5 + 0.5 * Math.min(1, Math.max(0, this.random()));
    return Math.max(1, Math.round(cap * factor));
  }

  private recordFailedRefresh(message: string): void {
    this.lastRefreshAt = this.clock.now();
    this.lastRefreshStatus = 'failed';
    this.lastError = sanitize(message);
    this.consecutiveFailures += 1;
    this.totalFailures += 1;
    this.totalRefreshes += 1;

    if (this.circuitBreakerState === 'half-open') {
      this.openCircuitBreaker('half-open probe failed');
    } else if (this.consecutiveFailures >= this.circuitBreakerThreshold && this.circuitBreakerState !== 'open') {
      this.openCircuitBreaker(`${this.consecutiveFailures} consecutive failures`);
    }

    this.logger.error(
      `[sanctions-scheduler] Feed refresh failed after ${this.maxRetries + 1} attempt(s): ${sanitize(message)}`,
    );
  }

  /**
   * A refresh cut short by `stop()` is an operator action, not an upstream
   * failure, so it is counted but must not drive the breaker towards opening.
   */
  private recordAbortedRefresh(): void {
    this.lastRefreshAt = this.clock.now();
    this.lastRefreshStatus = 'failed';
    this.lastError = ABORTED_MESSAGE;
    this.totalFailures += 1;
    this.totalRefreshes += 1;
    this.logger.info(`[sanctions-scheduler] ${ABORTED_MESSAGE}`);
  }

  private openCircuitBreaker(reason: string): void {
    this.circuitBreakerState = 'open';
    this.circuitBreakerOpenedAt = this.clock.now();
    this.circuitBreakerNextAttemptAt = new Date(
      this.circuitBreakerOpenedAt.getTime() + this.circuitBreakerResetTimeoutMs,
    );
    this.logger.error(
      `[sanctions-scheduler] Circuit breaker OPENED (${reason}); next probe at ${this.circuitBreakerNextAttemptAt.toISOString()}`,
    );
  }

  private closeCircuitBreaker(): void {
    if (this.circuitBreakerState !== 'closed') {
      this.logger.info('[sanctions-scheduler] Circuit breaker closed: feed recovered');
    }
    this.circuitBreakerState = 'closed';
    this.circuitBreakerOpenedAt = null;
    this.circuitBreakerNextAttemptAt = null;
  }

  /** A timer that never keeps the event loop alive on its own. */
  private setTimer(fn: () => void, ms: number): TimerHandle {
    const handle = setTimeout(fn, Math.max(0, ms));
    const unref = (handle as { unref?: () => void }).unref;
    if (typeof unref === 'function') unref.call(handle);
    return handle;
  }

  /** Backoff wait that `stop()` can cut short, so shutdown never waits it out. */
  private abortableSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.pendingSleeps.delete(finish);
        clearTimeout(handle);
        resolve();
      };
      const handle = this.setTimer(finish, ms);
      this.pendingSleeps.add(finish);
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Make a remote-derived string safe to log and to serve on a health endpoint:
 * no control characters (a feed could forge log lines) and a hard length cap.
 */
function sanitize(value: string, maxLength = 300): string {
  // \p{Cc} is the Unicode "control" category (C0 + DEL) — no literal control
  // characters in this pattern, which is also why it reads the way it does.
  return value.replace(/\p{Cc}/gu, ' ').slice(0, maxLength);
}

export interface LoadInitialFeedOptions {
  /** Feed URL, or null to keep the seeded EU list. */
  url: string | null;
  /** Minimum entries a fetched feed must have to be installed. */
  minEntries: number;
  /** Timeout and size limit for the fetch. */
  feedOptions?: LoadSanctionsFeedOptions;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * The boot fetch: load the live list before the server accepts traffic, so the
 * first submission is screened against live data. Any failure — including a
 * feed that parses into too few entries — falls back to the seeded EU list
 * rather than failing startup, because a reference-data outage must not take
 * the KYC pipeline down.
 */
export async function loadInitialSanctionsFeed(
  options: LoadInitialFeedOptions,
): Promise<SanctionsFeed | undefined> {
  const { url, minEntries, feedOptions = {}, logger = console } = options;
  if (!url) return undefined;
  try {
    const feed = await loadSanctionsFeed(url, feedOptions);
    if (!isFeedUsable(feed, minEntries)) {
      throw new Error(
        `feed returned ${feed.entries.length} entries, below the minimum ${minEntries}`,
      );
    }
    logger.info(
      `[sanctions-scheduler] Loaded ${feed.entries.length} sanctions entries at boot from ${sanitize(url)}`,
    );
    return feed;
  } catch (error) {
    logger.error(
      `[nft-kyc-hub] failed to load sanctions feed ${sanitize(url)}, using seeded list: ` +
        sanitize(describe(error)),
    );
    return undefined;
  }
}

/** What the composition root keeps: the scheduler plus its shutdown handle. */
export interface SanctionsFeedSchedulerHandle {
  scheduler: SanctionsFeedScheduler;
  stop: () => void;
}

/**
 * Create a scheduler that hot-swaps the RiskEngine's screener on successful refresh.
 * Returns the scheduler instance and a stop function.
 */
export function createSanctionsFeedScheduler(
  riskEngine: RiskEngine,
  options: SanctionsFeedSchedulerOptions,
): SanctionsFeedSchedulerHandle {
  const scheduler = new SanctionsFeedScheduler(options, (feed) => {
    riskEngine.updateScreener(feed.entries, feed.listName);
  });
  scheduler.start();
  return {
    scheduler,
    stop: () => scheduler.stop(),
  };
}
