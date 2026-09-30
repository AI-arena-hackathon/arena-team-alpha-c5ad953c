# NFT‑KYC Hub

Team alpha — spec §3.2 hackathon build.

**One-liner:** A lightweight, on‑chain KYC verification service that lets NFT marketplaces in the EU automatically meet the new Digital Services Act and Anti‑Money Laundering rules.

**Problem:** Since 2025 the EU Digital Services Act requires NFT marketplaces to verify sellers’ identities and monitor transactions for illicit activity, but current solutions are fragmented, costly, and not tailored to the unique token economy. Marketplaces must either hire expensive legal teams or integrate complex identity platforms that add friction for creators.

**Solution:** NFT‑KYC Hub offers a plug‑in that authenticates creators via verifiable credentials (e.g., EU e‑ID, blockchain‑verified passports), records the evidence on a tamper‑proof ledger, and provides real‑time AML risk scoring. The service auto‑generates compliance reports and integrates with marketplace APIs, so listings are blocked until KYC is complete and any high‑risk transactions are flagged for review.

**Build scope:** **NFT‑KYC Hub – Day 4‑5 Architecture (spec §3.1)**  

**Tech stack**  
- **Compute:** AWS Lambda (Node 20) – serverless, auto‑scales, low latency.  
- **Data store:** DynamoDB (single‑table design) for KYC records, credential hashes, risk scores.  
- **Identity verification:** EU e‑IDAS “e‑Signature” gateway (e.g., FranceConnect) via OAuth 2.0/OpenID Connect.  
- **Ledger:** Polygon zk‑EVM side‑chain – cheap, immutable proof‑of‑KYC anchor (store IPFS CID of encrypted JSON).  
- **API gateway & auth:** AWS API Gateway + Cognito JWT for partner keys.  
- **Frontend:** React + Vite, hosted on CloudFront (static dashboard).  

**Three core components**  
1. **KYC Ingestion Service** – Lambda endpoint `/kyc/submit` validates payload, invokes e‑ID provider, encrypts personal data (AES‑256‑GCM), writes hash & metadata to DynamoDB, and posts CID to Polygon.  
2. **Risk‑Scoring Engine** – Lambda triggered by DynamoDB Stream; runs a lightweight XGBoost model (pre‑trained on AML sanctions lists) to output a 0‑100 score, stores result, and pushes webhook to marketplace.  
3. **Compliance Dashboard & Reporting** – React UI reads DynamoDB via GraphQL (AppSync), shows status tiles, and calls `/report/pdf` Lambda to assemble a signed PDF (PDF‑sign with ECDSA) using PDF‑Lib.  

**Top 2 risks**  
- **Regulatory lock‑in:** EU e‑ID providers may change schema; mitigate by abstracting the provider behind an adapter layer and supporting at least two vendors from day 1.  
- **On‑chain privacy breach:** Storing any PII on‑chain is illegal. Mitigate by only anchoring a salted hash + encrypted CID; keep decryption keys off‑chain in AWS KMS.  

**Fallback scope (if schedule slips)**  
- Drop Polygon anchoring → keep tamper‑evidence in DynamoDB TTL + periodic signed snapshots to S3.  
- Replace ML risk model with rule‑based sanction list lookup (instant, no training data).  

*All components fit within a ≤ $150 monthly AWS budget for the 30‑day MVP.*

Built entirely by an AI coding agent across discrete GitHub Actions build turns (spec §8) — no human-written code.

---

## What is built today

The API service described above, working end to end. Three of the spec's
components are implemented behind a partner-facing HTTP API; the dashboard UI
and the on‑chain anchoring are not built yet (see `BACKLOG.md`).

| Spec component | Status | Where |
| --- | --- | --- |
| KYC Ingestion Service | **done** | `src/services/kycService.ts`, `src/http/app.ts` |
| Risk‑Scoring Engine | **done** (rule‑based, per the fallback scope) | `src/risk/engine.ts`, `src/risk/sanctions.ts` |
| Compliance Reporting | **done** (signed JSON, not yet PDF) | `src/services/reportService.ts` |
| e‑ID verification | **done** behind a two‑vendor adapter layer | `src/identity/eidProvider.ts` |
| Tamper‑evident ledger | **done** as an append‑only hash chain | `src/ledger/chain.ts` |
| React dashboard | not built | — |

### The primary flow

```
POST /v1/kyc/submissions        seller data + e-ID credential  -> approve / review / reject
POST /v1/listings/:id/check     marketplace listing gate        -> 200 allowed | 409 blocked + remediation
GET  /v1/compliance/report      signed, PII-free audit artefact
GET  /v1/ledger/verify          proof the decision history is untampered
```

A submission runs: shape validation (zod) → semantic validation → idempotency
check → e‑ID verification → sanctions screening + weighted AML scoring →
AES‑256‑GCM encryption of the personal data → PII‑free record stored → salted
credential digest anchored on the hash chain.

### Privacy posture (the product's hard requirement)

* Personal data is **encrypted before it is stored** (AES‑256‑GCM, submission id
  bound in as AAD, key id stored per envelope for rotation). No plaintext name,
  date of birth or document number ever touches the database.
* The ledger, the compliance report and the decision log carry **no PII at
  all** — only salted credential digests and anchor hashes. Tests in
  `src/security/redaction.test.ts`, `src/services/kycService.test.ts` and
  `src/services/reportService.test.ts` fail the build if that ever changes.
* Risk scores always come with human‑readable reason codes, so a reviewer can
  audit a decision without opening the encrypted evidence.

### Risk decision policy

`src/risk/engine.ts` implements the spec's documented fallback scope: a
versioned, transparent weighted model instead of an untrained XGBoost.

* **blocking** — sanctions match, identity verification failure, missing GDPR
  consent, subject under 18 → `reject`.
* **review‑only** — PEP, FATF high‑risk jurisdiction, expired document, large
  wallet volume, name/DOB mismatch. These are *not* aggregable: a single expired
  passport reaches a human even though its weight is below the review threshold.
* **score‑only** — thin wallet history, new wallet, undeclared source of funds,
  non‑EEA subject: these accumulate.

Sanctions matching is token‑exact after diacritic and punctuation normalisation
(`MOROZOV, Viktor-Petrovich` matches `Viktor Petrovich Morozov`), corroborated by
date of birth. Fuzzy matching is deliberately avoided: a false positive blocks a
real creator, a false negative is a regulatory failure.

## Running it

Requires Node 20+.

```bash
npm install
cp .env.example .env
set -a; . ./.env; set +a     # or export the variables your way

npm run dev                  # ts-node, hot iteration
npm run build && npm start   # compiled dist/

npm test                     # jest (212 tests)
npm run test:coverage        # with coverage thresholds enforced
npm run typecheck            # tsc --noEmit
npm run lint                 # eslint
```

With no secrets configured the service still boots in development using
placeholder values and prints a warning for each one; in production it refuses
to start until every secret is real (`src/config.ts`).

### Try the flow

`npm run build && PORT=3111 npm start`, then, in another shell:

```bash
# 1. health probe (no partner key required)
curl -s localhost:3111/health

# 2. mint an e-IDAS assertion and submit a KYC submission
#    (the signing helper is exported from src/identity/eidProvider.ts)
node -e "
const API_KEY = 'dev-key-local-only';               // dev default from .env.example
const { signAssertion } = require('./dist/identity/eidProvider');
const assertion = signAssertion({
  iss: 'https://eidas-gateway.demo/issuer', sub: 'seller-777',
  name: 'Ines Ferreira', birth_date: '1991-04-17',
  acr: 'high', aalink: 'passport',
  iat: new Date().toISOString(),
  exp: new Date(Date.now() + 864e5 * 365).toISOString(),
}, process.env.EID_EIDAS_SECRET);

fetch('http://localhost:3111/v1/kyc/submissions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
  body: JSON.stringify({
    submissionId: 'kyc_demo_0001',
    subject: {
      subjectId: 'seller-777', fullName: 'Ines Ferreira',
      dateOfBirth: '1991-04-17', countryCode: 'PT',
      document: { type: 'passport', number: 'PT4417X', issuingCountry: 'PT', expiresOn: '2031-04-16' },
      wallet: { address: '0x1111111111111111111111111111111111111111', chain: 'polygon',
                firstSeenAt: '2021-06-01T00:00:00.000Z', transactionCount: 412, volumeUsd: 48000 },
    },
    claims: { sourceOfFunds: 'salary' },
    credential: { format: 'eidas', assertion },
    consent: { granted: true, capturedAt: new Date().toISOString() },
    listingId: 'listing-demo-1',
  }),
}).then(r => r.json()).then(console.log);
"

# 3. the listing gate
curl -s -X POST localhost:3111/v1/listings/listing-demo-1/check \
  -H 'content-type: application/json' -H 'x-api-key: <your key>' \
  -d '{"subjectId":"seller-777"}'

# 4. the audit artefacts
curl -s localhost:3111/v1/ledger/verify -H 'x-api-key: <your key>'
curl -s localhost:3111/v1/compliance/report -H 'x-api-key: <your key>'
```

### API surface

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | liveness, adapters, config warnings |
| `GET` | `/v1/health/details` | partner | ledger integrity + served marketplaces |
| `POST` | `/v1/kyc/submissions` | partner | ingest and decide a seller KYC |
| `GET` | `/v1/kyc/submissions/:id` | partner | PII‑free decision record |
| `GET` | `/v1/kyc/subjects/:subjectId` | partner | decision history for one seller |
| `POST` | `/v1/listings/:listingId/check` | partner | the listing gate |
| `GET` | `/v1/compliance/report?from&to` | partner | signed compliance report |
| `GET` | `/v1/ledger/verify` | partner | chain integrity proof |
| `GET` | `/v1/ledger/anchors/:hash` | partner | fetch one anchor |

Partner authentication is an `x-api-key` header (or `Authorization: ApiKey …`)
compared in constant time against stored SHA‑256 digests. In the deployed
topology API Gateway + Cognito JWT sits in front; `src/http/middleware/auth.ts` is
the single place the partner identity is resolved.

Errors are always `{ error, message, details? }` with a 4xx/5xx status — a
listing that must stay blocked answers `409` with the remediation the marketplace
should show its seller.

## Repository layout

```
src/
  index.ts            server bootstrap and graceful shutdown
  container.ts        composition root (every dependency injected)
  config.ts           environment parsing, production refusals
  domain/types.ts     PII-free domain model
  http/               express app, schemas, auth and error middleware
  identity/           e-ID vendor adapters (eIDAS, FranceConnect) + registry
  risk/               sanctions screener, weighted scoring engine, reference data
  ledger/             append-only tamper-evident hash chain
  security/           AES-256-GCM envelopes, credential digests, PII detectors
  services/           KYC ingestion, listing gate, compliance reporting
  store/              repository port (in-memory reference implementation)
  util/               canonical JSON, clock, ids
```

Tests live next to the code they cover (`*.test.ts`) and drive the real code
paths — the HTTP suite starts a real server and talks to it over TCP.

## Honest limitations

* The repository is in‑memory, so records do not survive a restart. The
  `KycRepository` port is shaped by DynamoDB access patterns
  (`MARKETPLACE#…#SUBJECT#…` keys) so the AWS adapter drops in without touching
  product code — see the backlog item.
* Assertions are validated with a shared‑secret HMAC rather than a real eIDAS
  PKI/JWKS check. Swapping the validator is one method per adapter.
* The sanctions list is a small seeded subset of the EU consolidated list, not a
  live feed.
* Report signatures are HMAC‑SHA256; the spec's ECDSA‑signed PDF is not built yet.
