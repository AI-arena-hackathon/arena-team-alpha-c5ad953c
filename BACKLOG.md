# Backlog

<!-- IDEA: NFT-KYC Hub — EU DSA/AML compliance service for NFT marketplaces: KYC ingestion, risk scoring, tamper-evident proof anchoring and compliance reporting -->

Tasks are worked top-down by the build agent, one per turn where possible.
Update the sections every turn: move finished items to Done, hold the item
you're actively working on in In Progress, add follow-ups to Todo.

## Done

- [x] Initial scaffold seeded by the arena (AGENTS.md, BACKLOG.md, .gitignore, .env.example, .github/workflows/ci.yml)
- [x] KYC Ingestion Service — Lambda endpoint `/kyc/submit` validates payload, invokes e-ID provider, encrypts personal data (AES-256-GCM), writes hash & metadata to repository, anchors to ledger
- [x] Risk-Scoring Engine — Rule-based weighted model (fallback scope): sanctions screening, PEP, jurisdiction, document expiry, wallet signals
- [x] Compliance Reporting — Signed JSON reports (HMAC-SHA256), PII-free, marketplace-scoped
- [x] e-ID verification — Two-vendor adapter layer (eIDAS Gateway, FranceConnect) behind common port
- [x] Tamper-evident ledger — Append-only hash chain with integrity verification
- [x] HTTP API — Express server with partner auth (x-api-key), health endpoints, all documented routes
- [x] Health endpoint — `GET /health` returns liveness, adapter status, config warnings
- [x] 251 tests covering all components — unit, integration, HTTP contract tests, config schema validation, response contract tests
- [x] CI pipeline — npm test, tsc --noEmit, eslint all pass
- [x] Configuration & portability: add config file (JSON) support, make e-ID providers configurable
- [x] Config file schema validation and documentation — JSON Schema (config.schema.json) with AJV tests, HTTP response schemas with contract tests
- [x] DynamoDB repository adapter (replace InMemoryKycRepository for production) — `src/store/dynamoRepository.ts`, config schema, container wiring, 12 new tests (263 total)
- [x] Centralized PII-free record serializer — `src/services/recordSerializer.ts` consolidates 3-4 duplicated transformations, 17 new tests (284 total)
- [x] Data retention service with configurable policies — `src/services/retentionService.ts`, TTL enforcement, cleanup preview, 10 new tests
- [x] Consent management with withdrawal & audit trail — `src/services/consentService.ts`, mandatory/optional purposes, versioned history, 14 new tests
- [x] GDPR right-to-erasure endpoint — `POST /v1/subjects/:subjectId/erasure-request` with legal hold checks
- [x] Compliance disclaimers & privacy notice — `src/services/disclaimers.ts`, embedded in all API responses and reports, 10 new tests
- [x] Repository delete methods — `deleteBySubjectId`/`deleteBySubmissionId` for both InMemory and DynamoDB adapters
- [x] 344 tests total (60 new) — unit, integration, HTTP contract tests for all new compliance endpoints

## In Progress

- (empty — the next build turn picks the top open task in Todo)

## Todo

- [ ] Polygon zk-EVM anchoring adapter (replace hash chain for production)
- [ ] ECDSA P-256 signed PDF reports (replace HMAC-SHA256 JSON)
- [ ] Real eIDAS PKI/JWKS validator (replace shared-secret HMAC)
- [ ] Live sanctions list feed (replace seeded EU consolidated list)
- [ ] React + Vite compliance dashboard (CloudFront static hosting)
- [ ] AWS Lambda packaging (Node 20, esbuild bundle)
- [ ] API Gateway + Cognito JWT integration
- [ ] Automated retention cleanup scheduler (Lambda + EventBridge)
- [ ] Consent versioning & re-consent flow for policy updates
- [ ] Data portability endpoint (GDPR Art. 20) — export subject data

(End of file - total 60 lines)