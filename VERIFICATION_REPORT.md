# Verification report — turn 18

Scope: finish the interrupted backlog item *scheduled sanctions-feed refresh
instead of load-once-at-startup*, harden its failure paths, and prove it
against a real running app.

| Phase | Command | Result | Exit |
|---|---|---|---|
| Build | `npm run build` | PASS | 0 |
| Typecheck | `npm run typecheck` | PASS | 0 |
| Lint | `npm run lint` | PASS | 0 |
| Test | `npm test` | PASS | 0 |
| Security | `npm audit --omit=dev` | PASS — 0 vulnerabilities | 0 |
| Diff | `git status --porcelain` + `git diff --stat` | 18 files changed (2 new, 16 modified), +723/−34 on tracked | — |

## Test evidence
- command: `npm test`
- result: **25 suites passed, 460 tests passed, 0 failed, 0 skipped** (16.1 s)
- coverage (`npm run test:coverage`): statements 91.71 % (1682/1834), branches
  82.91 % (689/831), functions 92.5 % (321/347), lines 92.32 % (1612/1746)
- failing test names: none
- new this turn:
  - `src/services/sanctionsFeedScheduler.test.ts` — 34 tests (new file)
  - `src/http/app.test.ts` — `sanctions feed refresh over HTTP` describe block
  - `src/http/responseSchemas.test.ts` — +6 scheduler health-schema tests
  - `src/config.test.ts` — +6 refresh-knob tests, incl. `SANCTIONS_FEED_REFRESH_ENABLED=false`
  - `src/config.schema.test.ts` — +4
  - `src/container.test.ts` — +4 wiring tests
  - `src/risk/sanctions.test.ts` — +3 `isFeedUsable` tests

## Browser verification (`ui-verify`, real app on :4600, fixture feed on :4599)
The scheduler was exercised end-to-end in a running instance, not just in unit
tests. A disposable fixture served one EU entry (`EU-FEED-77`, Katya Belova
Sorokin) and could be flipped to HTTP 503.

1. **Boot** — `Loaded 1 sanctions entries at boot …` then
   `Starting with interval 20000ms (boot feed still fresh, first refresh after one interval)`.
   The boot fetch is not duplicated by an immediate refresh.
2. **Unauthenticated `/health`** exposed only
   `enabled/lastRefreshStatus/lastRefreshAt/consecutiveFailures/circuitBreakerState/totalRefreshes/totalFailures/installedEntries/minEntries` —
   **no `url`, no `lastError`**.
3. **`/v1/health/details` without a key → 401**; with the partner key → full
   metrics including `url` and `lastError`.
4. **Scheduled refresh fires on its own** — after one interval,
   `lastRefreshStatus: success`, `totalRefreshes: 1`, breaker `closed`.
5. **Outage** — feed flipped to 503: retries with jittered backoff
   (`Retrying in 471ms / 409ms / 399ms / 453ms` from a 500 ms base), then
   `Circuit breaker OPENED (half-open probe failed); next probe at …` after
   the configured threshold. `installedEntries` stayed at 1.
6. **Screening kept working on the retained list while the feed was down** —
   `POST /v1/kyc/submissions` for the sanctioned subject returned
   `decision: reject` with reason `SANCTIONS_MATCH`
   (`eu-consolidated#EU-FEED-77 … matched on name_and_dob`) and
   `sanctionsHits` populated, while a clean subject got `sanctionsHits: []`.
   A failed refresh degrades freshness, never the block decision.
7. **Recovery** — feed restored: repeated
   `Circuit breaker half-open: allowing one test request` probes, then
   `Circuit breaker closed: feed recovered`; `consecutiveFailures: 0`,
   `lastError: null`, `installedEntries: 1`.

Screenshots: `/tmp/playwright-artifacts/page-2026-10-02T03-03-39-482Z.png`
(nothing committed). Only console error during the pass was a `favicon.ico`
404, unrelated to this change. Both background servers were stopped and the
scratch launchers deleted — `git status` shows no stray files.

## Review findings, fixed before this report
Loaded `code-review-and-quality` and `security-and-hardening`.
- **Boot path bypassed the new guard** — the `SANCTIONS_LIST_URL` fetch in
  `src/index.ts` installed a feed with no minimum-entry check. Extracted
  `isFeedUsable(feed, minEntries)` in `src/risk/sanctions.ts` and
  `loadInitialSanctionsFeed()`; the boot path now shares the guard with the
  scheduler. +3 tests.
- **`z.coerce.boolean()` treated the string `"false"` as `true`** — the
  documented way to disable refreshes would have *enabled* them. Replaced with
  `envBoolean()`, which accepts `true/false/1/0/yes/no/on/off` and throws on
  anything else. +tests including the off-spellings.
- **Log forging via remote text** — upstream-controlled strings (error
  messages, `describe()` output) reach log lines. All remote-derived text now
  goes through `sanitize()` (strips `\p{Cc}` control characters, caps at 300
  chars) before logging *and* before being published as `lastError`.
- **Unauthenticated metric leak** — `/health` uses `toSchedulerSummary()`,
  which omits `url` and `lastError`; full metrics stay behind auth. Schema
  contract locked down with +6 schema tests.
- **`start()` was not a true no-op** — a second `start()` on a running
  scheduler reset the breaker and failure streak before the early return. The
  guard now precedes the state reset; the test asserts metrics are unchanged
  by a second `start()`.

## Security notes
- dependency audit: clean — `found 0 vulnerabilities` (production deps).
- secrets: none introduced. All credentials used in the browser pass were
  disposable local values in environment variables; the repo's `.env` remains
  gitignored and only `.env.example` is tracked.
- log injection: covered by `sanitize()` + a dedicated test.
- access control: the 401-vs-200 split on `/v1/health/details` was verified in
  the live app, not only in tests.
- No `.github/` file was read for commands or modified; the CI workflow is the
  arena's.

## Verdict
READY
The scheduler is shipped and green: it refreshes on a schedule, survives a
total upstream outage without ever dropping the active list or a block
decision, and reports its state without leaking the feed URL to unauthenticated
probes. Next turn: wire `triggerRefresh()` to the EventBridge/Lambda entry
point (the backlog follow-up) — the escape hatch exists but has no transport.
