import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { SubmissionValidationError } from '../../services/kycService';
import { EncryptionError } from '../../security/encryption';

/**
 * Uniform error contract: every failure leaves the API as
 * `{ error, message, details? }` with an appropriate status, so partner
 * integrations can branch on `error` instead of parsing prose.
 *
 * Nothing internal leaks: unexpected errors are logged server-side and reported
 * to the caller as a generic 500, so stack traces, SQL/keyring details and file
 * paths never reach a partner.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'not_found',
    message: `no route for ${req.method} ${req.path}`,
  });
}

export function errorHandler(logger: Pick<Console, 'error'> = console) {
  return function handle(error: unknown, _req: Request, res: Response, next: NextFunction): void {
    if (res.headersSent) {
      next(error);
      return;
    }

    // Body-parser failures (bad JSON, payload too large) are client errors and
    // carry their own status; without this they would surface as 500s.
    const parserError = asBodyParserError(error);
    if (parserError) {
      res.status(parserError.status).json({
        error: parserError.code,
        message: parserError.message,
      });
      return;
    }

    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'validation_failed',
        message: 'request body failed validation',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      });
      return;
    }

    if (error instanceof SubmissionValidationError) {
      res.status(400).json({
        error: 'validation_failed',
        message: error.message,
        details: [{ path: error.field, message: error.message }],
      });
      return;
    }

    if (error instanceof HttpError) {
      res.status(error.status).json({
        error: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      return;
    }

    if (error instanceof EncryptionError) {
      // An envelope that fails to decrypt is a security event, not a client bug.
      logger.error('[kyc] envelope decryption failed', { name: error.name, message: error.message });
      res.status(500).json({ error: 'internal_error', message: 'stored evidence could not be verified' });
      return;
    }

    logger.error('[kyc] unhandled error', error);
    res.status(500).json({ error: 'internal_error', message: 'unexpected server error' });
  };
}

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

interface BodyParserError {
  status: number;
  code: string;
  message: string;
}

/**
 * Recognises the errors `express.json()` raises for malformed or oversized
 * payloads. They are identified structurally (type/status/expose) rather than by
 * importing body-parser, so the mapping stays readable.
 */
function asBodyParserError(error: unknown): BodyParserError | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as {
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
  };
  if (typeof candidate.type !== 'string' || !candidate.type.startsWith('entity.')) return undefined;

  const tooLarge = candidate.type === 'entity.too.large';
  const reported =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : undefined;
  // Trust an explicit status, otherwise derive the right one from the failure type.
  const status = reported ?? (tooLarge ? 413 : 400);
  if (status < 400 || status > 499) return undefined;

  return {
    status,
    code: tooLarge ? 'payload_too_large' : 'invalid_request_body',
    message: tooLarge
      ? 'request body exceeds the 256kb limit'
      : 'request body is not valid JSON',
  };
}