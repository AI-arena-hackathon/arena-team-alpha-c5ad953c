import express, { type Express, type Request, type Response } from 'express';
import type { LedgerAdapter } from '../ledger/adapter';
import type { KycService } from '../services/kycService';
import type { ListingGate } from '../services/listingGate';
import type { ReportService } from '../services/reportService';
import type { RetentionService } from '../services/retentionService';
import type { ConsentService } from '../services/consentService';
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
import { recordSerializer } from '../services/recordSerializer';
import { getApiDisclaimer, getReportDisclaimers, getConsentDisclaimers, getPrivacyNotice, getDisclaimerVersion } from '../services/disclaimers';
import { z } from 'zod';

export interface AppDeps {
  config: AppConfig;
  clock: Clock;
  kycService: KycService;
  listingGate: ListingGate;
  reportService: ReportService;
  retentionService: RetentionService;
  consentService: ConsentService;
  repository: KycRepository;
  ledger: LedgerAdapter;
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

  app.get(`${API}/health/details`, auth, asyncHandler(async (_req, res) => {
    const chain = await deps.ledger.verify();
    res.json({
      status: chain.valid ? 'ok' : 'degraded',
      ledger: chain,
      submissions: deps.config.partners.map((partner) => partner.marketplaceId),
    });
  }));

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
        risk: recordSerializer.serializeRisk(result.record.risk),
        identity: result.record.identity,
        credentialDigest: result.record.credentialDigest,
        ledger: result.ledgerAnchor,
        idempotentReplay: result.idempotentReplay,
        listingBlocked: result.record.status !== 'verified',
        disclaimer: getApiDisclaimer('kycSubmission'),
        disclaimerVersion: getDisclaimerVersion(),
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
      res.json(recordSerializer.toPublicRecord(record));
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
        history: history.map((r) => recordSerializer.toPublicRecord(r)),
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
      res.status(decision.allowed ? 200 : 409).json({
        ...decision,
        disclaimer: getApiDisclaimer('listingCheck'),
        disclaimerVersion: getDisclaimerVersion(),
      });
    }),
  );

  app.get(
    `${API}/compliance/report`,
    auth,
    asyncHandler(async (req, res) => {
      const query = reportQuerySchema.parse(req.query);
      const report = await deps.reportService.generate(partnerOf(req), query);
      res.json({
        ...report,
        disclaimer: getReportDisclaimers(),
        disclaimerVersion: getDisclaimerVersion(),
      });
    }),
  );

  app.get(`${API}/ledger/verify`, auth, asyncHandler(async (_req, res) => {
    const chain = await deps.ledger.verify();
    res.json({
      ...chain,
      disclaimer: getApiDisclaimer('ledgerVerify'),
      disclaimerVersion: getDisclaimerVersion(),
    });
  }));

  app.get(`${API}/ledger/anchors/:hash`, auth, (req, res) => {
    const hash = String(req.params.hash ?? '');
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new HttpError(400, 'validation_failed', 'hash must be 64 lowercase hex characters');
    }
    const entry = deps.ledger.find(hash);
    if (!entry) throw new HttpError(404, 'not_found', 'no ledger anchor with that hash');
    res.json(entry);
  });

  // Consent management endpoints
  const consentWithdrawSchema = z.object({
    purposes: z.array(z.enum([
      'kyc_processing', 'aml_screening', 'ledger_anchoring',
      'compliance_reporting', 'risk_scoring', 'marketing', 'analytics'
    ])).min(1),
    ip: z.string().optional(),
    userAgent: z.string().optional(),
  });

  app.get(
    `${API}/consent/status/:subjectId`,
    auth,
    asyncHandler(async (req, res) => {
      const { subjectId } = subjectParamSchema.parse(req.params);
      const status = await deps.consentService.getConsentStatus(partnerOf(req), subjectId);
      res.json({
        ...status,
        disclaimer: getConsentDisclaimers().withdrawal,
        disclaimerVersion: getDisclaimerVersion(),
      });
    }),
  );

  app.post(
    `${API}/consent/withdraw/:subjectId`,
    auth,
    asyncHandler(async (req, res) => {
      const { subjectId } = subjectParamSchema.parse(req.params);
      const body = consentWithdrawSchema.parse(req.body);
      try {
        const record = await deps.consentService.withdrawConsent({
          marketplaceId: partnerOf(req),
          subjectId,
          purposes: body.purposes,
          ip: body.ip,
          userAgent: body.userAgent,
        });
        res.json({
          consentId: record.consentId,
          subjectId: record.subjectId,
          granted: record.granted,
          purposes: record.purposes,
          withdrawnAt: record.withdrawnAt,
          disclaimer: getConsentDisclaimers().withdrawal,
          disclaimerVersion: getDisclaimerVersion(),
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('No consent record found')) {
          throw new HttpError(404, 'not_found', error.message);
        }
        if (error instanceof Error && error.message.includes('already withdrawn')) {
          throw new HttpError(409, 'conflict', error.message);
        }
        throw error;
      }
    }),
  );

  // Right to erasure (GDPR Article 17)
  const erasureRequestSchema = z.object({
    reason: z.string().min(1).max(500),
    confirmDeletion: z.literal(true),
  });

  app.post(
    `${API}/subjects/:subjectId/erasure-request`,
    auth,
    asyncHandler(async (req, res) => {
      const { subjectId } = subjectParamSchema.parse(req.params);
      const _body = erasureRequestSchema.parse(req.body);

      // Check if subject exists
      const records = await deps.repository.listBySubject(partnerOf(req), subjectId);
      if (records.length === 0) {
        throw new HttpError(404, 'not_found', `no records found for subject ${subjectId}`);
      }

      // Check for legal holds (sanctions matches, ongoing investigations)
      const hasLegalHold = records.some(
        (r) => r.risk.sanctionsHits.length > 0 || r.decision === 'reject'
      );

      if (hasLegalHold) {
        throw new HttpError(
          409,
          'legal_hold',
          'Erasure request cannot be fulfilled due to legal hold (sanctions match or rejection). Contact DPO for manual review.',
        );
      }

      // Delete all KYC records for the subject
      const deletedCount = await deps.repository.deleteBySubjectId(partnerOf(req), subjectId);

      // Also delete consent record (if exists)
      try {
        await deps.consentService.withdrawConsent({
          marketplaceId: partnerOf(req),
          subjectId,
          purposes: ['kyc_processing', 'aml_screening', 'ledger_anchoring', 'compliance_reporting', 'risk_scoring'],
        });
      } catch (error) {
        // Consent record may not exist; that's fine for erasure
        if (error instanceof Error && !error.message.includes('No consent record found')) {
          throw error;
        }
      }

      res.json({
        subjectId,
        deletedRecords: deletedCount,
        status: 'completed',
        requestedAt: deps.clock.now().toISOString(),
        disclaimer: getPrivacyNotice().rightsSummary,
        disclaimerVersion: getDisclaimerVersion(),
      });
    }),
  );

  // Retention management endpoints
  app.get(
    `${API}/retention/policy`,
    auth,
    asyncHandler(async (req, res) => {
      const policy = deps.retentionService.getPolicy();
      res.json({
        policy,
        disclaimer: getReportDisclaimers().retention,
        disclaimerVersion: getDisclaimerVersion(),
      });
    }),
  );

  app.get(
    `${API}/retention/preview`,
    auth,
    asyncHandler(async (req, res) => {
      const preview = await deps.retentionService.getCleanupPreview(partnerOf(req));
      res.json({
        ...preview,
        disclaimer: getReportDisclaimers().retention,
        disclaimerVersion: getDisclaimerVersion(),
      });
    }),
  );

  app.post(
    `${API}/retention/cleanup`,
    auth,
    asyncHandler(async (req, res) => {
      const result = await deps.retentionService.runCleanup(partnerOf(req));
      res.json({
        ...result,
        disclaimer: getReportDisclaimers().retention,
        disclaimerVersion: getDisclaimerVersion(),
      });
    }),
  );

  // Disclaimer and privacy notice endpoints
  app.get(`${API}/disclaimers`, auth, (_req, res) => {
    res.json({
      version: getDisclaimerVersion(),
      api: {
        kycSubmission: getApiDisclaimer('kycSubmission'),
        listingCheck: getApiDisclaimer('listingCheck'),
        complianceReport: getApiDisclaimer('complianceReport'),
        ledgerVerify: getApiDisclaimer('ledgerVerify'),
      },
      report: getReportDisclaimers(),
      consent: getConsentDisclaimers(),
      privacy: getPrivacyNotice(),
    });
  });

  app.get(`${API}/privacy-notice`, (_req, res) => {
    res.json({
      version: getDisclaimerVersion(),
      ...getPrivacyNotice(),
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler());

  return app;
}

function partnerOf(req: Request): string {
  const marketplaceId = req.partner?.marketplaceId;
  if (!marketplaceId) {
    throw new HttpError(401, 'unauthorized', 'partner identity missing');
  }
  return marketplaceId;
}
