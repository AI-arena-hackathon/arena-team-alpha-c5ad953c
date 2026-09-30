import express, { type Express, type Request, type Response } from 'express';
import type { LedgerChain } from '../ledger/chain';
import type { KycService } from '../services/kycService';
import type { ListingGate } from '../services/listingGate';
import type { ReportService } from '../services/reportService';
import type { KycRepository } from '../store/repository';
import type { AppConfig } from '../config';
import type { Clock } from '../util/clock';
import { partnerAuth } from './middleware/auth';
import { asyncHandler, errorHandler, HttpError, notFoundHandler } from './middleware/errors';
import {
  listingCheckSchema,
  listingParamSchema,
  reportQuerySchema,
  submissionIdSchema,
  submissionSchema,
  subjectParamSchema,
} from './schemas';

export interface AppDeps {
  config: AppConfig;
  clock: Clock;
  kycService: KycService;
  listingGate: ListingGate;
  reportService: ReportService;
  repository: KycRepository;
  ledger: LedgerChain;
  providerIds: string[];
  startedAt: Date;
}

const API = '/v1';

/**
 * Partner-facing HTTP surface.
 *
 *   GET  /health                         liveness + configuration warnings
 *   POST /v1/kyc/submissions             ingest a seller KYC submission
 *   GET  /v1/kyc/submissions/:id         fetch the PII-free decision record
 *   GET  /v1/kyc/subjects/:subjectId     decision history for one seller
 *   POST /v1/listings/:listingId/check   the listing gate
 *   GET  /v1/compliance/report           signed, PII-free compliance report
 *   GET  /v1/ledger/verify               hash-chain integrity proof
 *
 * Every /v1 route is partner-authenticated; /health is open by design so a load
 * balancer can probe it.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  const auth = partnerAuth(deps.config.partners);

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'nft-kyc-hub',
      version: '0.1.0',
      startedAt: deps.startedAt.toISOString(),
      now: deps.clock.now().toISOString(),
      environment: deps.config.nodeEnv,
      adapters: deps.providerIds,
      sanctionsList: deps.config.sanctionsList,
      warnings: deps.config.warnings,
    });
  });

  app.get(`${API}/health/details`, auth, (_req, res) => {
    const chain = deps.ledger.verify();
    res.json({
      status: chain.valid ? 'ok' : 'degraded',
      ledger: chain,
      submissions: deps.config.partners.map((partner) => partner.marketplaceId),
    });
  });

  app.post(
    `${API}/kyc/submissions`,
    auth,
    asyncHandler(async (req, res) => {
      const body = submissionSchema.parse(req.body);
      const marketplaceId = partnerOf(req);
      const result = await deps.kycService.submit(marketplaceId, body);

      res.status(result.idempotentReplay ? 200 : 201).json({
        submissionId: result.record.submissionId,
        subjectId: result.record.subjectId,
        status: result.record.status,
        decision: result.record.decision,
        risk: {
          score: result.record.risk.score,
          band: result.record.risk.band,
          modelVersion: result.record.risk.modelVersion,
          reasons: result.record.risk.features.map((item) => ({
            code: item.code,
            label: item.label,
            weight: item.weight,
            detail: item.detail,
          })),
          sanctionsHits: result.record.risk.sanctionsHits,
        },
        identity: result.record.identity,
        credentialDigest: result.record.credentialDigest,
        ledger: result.ledgerAnchor,
        idempotentReplay: result.idempotentReplay,
        listingBlocked: result.record.status !== 'verified',
      });
    }),
  );

  app.get(
    `${API}/kyc/submissions/:submissionId`,
    auth,
    asyncHandler(async (req, res) => {
      const { submissionId } = submissionIdSchema.parse(req.params);
      const record = await deps.kycService.getRecord(partnerOf(req), submissionId);
      if (!record) {
        throw new HttpError(404, 'not_found', `no KYC submission "${submissionId}"`);
      }
      res.json(toPublicRecord(record));
    }),
  );

  app.get(
    `${API}/kyc/subjects/:subjectId`,
    auth,
    asyncHandler(async (req, res) => {
      const { subjectId } = subjectParamSchema.parse(req.params);
      const history = await deps.kycService.getSubjectHistory(partnerOf(req), subjectId);
      res.json({
        subjectId,
        submissions: history.length,
        currentStatus: history[history.length - 1]?.status ?? 'unknown',
        history: history.map(toPublicRecord),
      });
    }),
  );

  app.post(
    `${API}/listings/:listingId/check`,
    auth,
    asyncHandler(async (req, res) => {
      const { listingId } = listingParamSchema.parse(req.params);
      const { subjectId } = listingCheckSchema.parse(req.body ?? {});
      const decision = await deps.listingGate.check({
        marketplaceId: partnerOf(req),
        listingId,
        subjectId,
      });
      res.status(decision.allowed ? 200 : 409).json(decision);
    }),
  );

  app.get(
    `${API}/compliance/report`,
    auth,
    asyncHandler(async (req, res) => {
      const query = reportQuerySchema.parse(req.query);
      const report = await deps.reportService.generate(partnerOf(req), query);
      res.json(report);
    }),
  );

  app.get(`${API}/ledger/verify`, auth, (_req, res) => {
    res.json(deps.ledger.verify());
  });

  app.get(`${API}/ledger/anchors/:hash`, auth, (req, res) => {
    const hash = String(req.params.hash ?? '');
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new HttpError(400, 'validation_failed', 'hash must be 64 lowercase hex characters');
    }
    const entry = deps.ledger.find(hash);
    if (!entry) throw new HttpError(404, 'not_found', 'no ledger anchor with that hash');
    res.json(entry);
  });

  app.use(notFoundHandler);
  app.use(errorHandler());

  return app;
}

/** Strips the encrypted envelope: partners never receive ciphertext they cannot use. */
function toPublicRecord(record: import('../domain/types').KycRecord) {
  return {
    submissionId: record.submissionId,
    subjectId: record.subjectId,
    ...(record.listingId ? { listingId: record.listingId } : {}),
    status: record.status,
    decision: record.decision,
    risk: {
      score: record.risk.score,
      band: record.risk.band,
      reasons: record.risk.features,
      sanctionsHits: record.risk.sanctionsHits,
      modelVersion: record.risk.modelVersion,
    },
    identity: record.identity,
    credentialDigest: record.credentialDigest,
    ledgerAnchorHash: record.ledgerAnchorHash,
    consentCapturedAt: record.consentCapturedAt,
    submittedAt: record.submittedAt,
    evaluatedAt: record.evaluatedAt,
    evidenceStored: 'encrypted' as const,
  };
}

function partnerOf(req: Request): string {
  const marketplaceId = req.partner?.marketplaceId;
  if (!marketplaceId) {
    throw new HttpError(401, 'unauthorized', 'partner identity missing');
  }
  return marketplaceId;
}
