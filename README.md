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

*All components fit within a ≤ $150 monthly AWS budget for the 30‑day MVP.*

Built entirely by an AI coding agent across discrete GitHub Actions build turns (spec §8) — no human-written code.
