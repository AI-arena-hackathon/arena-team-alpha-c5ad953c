import type { NextFunction, Request, Response } from 'express';
import { ZodError, z } from 'zod';
import { asyncHandler, errorHandler, HttpError, notFoundHandler } from './errors';
import { EncryptionError } from '../../security/encryption';
import { SubmissionValidationError } from '../../services/kycService';

interface Capture {
  res: Response;
  status: () => number;
  body: () => Record<string, unknown>;
  headersSent: () => boolean;
}

function fakeResponse(): Capture {
  let statusCode = 200;
  let payload: Record<string, unknown> = {};
  let sent = false;

  const res = {
    headersSent: false,
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(body: Record<string, unknown>) {
      payload = body;
      sent = true;
      res.headersSent = true;
      return res;
    },
  } as unknown as Response;

  return {
    res,
    status: () => statusCode,
    body: () => payload,
    headersSent: () => sent,
  };
}

function run(error: unknown, capture = fakeResponse()) {
  const handle = errorHandler({ error: () => undefined });
  handle(error, {} as Request, capture.res, (() => undefined) as NextFunction);
  return capture;
}

describe('errorHandler', () => {
  it('turns a zod failure into 400 with per-field details', () => {
    const schema = z.object({ subjectId: z.string().min(3) });
    const capture = run(new ZodError(schema.safeParse({ subjectId: 'ab' }).error?.issues ?? []));

    expect(capture.status()).toBe(400);
    expect(capture.body()).toMatchObject({ error: 'validation_failed' });
    expect((capture.body().details as Array<{ path: string }>)[0].path).toBe('subjectId');
  });

  it('turns a semantic submission error into 400 naming the offending field', () => {
    const capture = run(new SubmissionValidationError('bad wallet', 'subject.wallet.address'));
    expect(capture.status()).toBe(400);
    expect(capture.body()).toMatchObject({ error: 'validation_failed' });
    expect(capture.body().details).toEqual([
      { path: 'subject.wallet.address', message: 'bad wallet' },
    ]);
  });

  it('passes explicit HttpErrors through with their status and details', () => {
    const capture = run(new HttpError(429, 'rate_limited', 'slow down', { retryAfter: 30 }));
    expect(capture.status()).toBe(429);
    expect(capture.body()).toMatchObject({
      error: 'rate_limited',
      message: 'slow down',
      details: { retryAfter: 30 },
    });
  });

  it('omits details when none were supplied', () => {
    const capture = run(new HttpError(404, 'not_found', 'gone'));
    expect(capture.body()).not.toHaveProperty('details');
  });

  it('hides internal detail when an envelope cannot be verified', () => {
    const capture = run(new EncryptionError('envelope failed authentication for key k-secret'));
    expect(capture.status()).toBe(500);
    expect(capture.body()).toEqual({
      error: 'internal_error',
      message: 'stored evidence could not be verified',
    });
    expect(JSON.stringify(capture.body())).not.toContain('k-secret');
  });

  it('never leaks an unexpected error to the caller', () => {
    const capture = run(new Error('ENOENT: /home/user/.aws/credentials'));
    expect(capture.status()).toBe(500);
    expect(capture.body()).toEqual({ error: 'internal_error', message: 'unexpected server error' });
  });

  it('delegates to express when the response already went out', () => {
    const capture = fakeResponse();
    const res = capture.res as unknown as Response & { headersSent: true };
    (res as unknown as { headersSent: boolean }).headersSent = true;
    const next = jest.fn();
    const handle = errorHandler();
    handle(new Error('too late'), {} as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ type: 'entity.parse.failed', status: 400 }, 400, 'invalid_request_body'],
    [{ type: 'entity.too.large', status: 413 }, 413, 'payload_too_large'],
    [{ type: 'entity.too.large' }, 413, 'payload_too_large'],
    [{ type: 'entity.parse.failed', statusCode: 422 }, 422, 'invalid_request_body'],
  ])('maps body-parser error %# to a client error', (error, status, code) => {
    const capture = run(error);
    expect(capture.status()).toBe(status);
    expect(capture.body()).toMatchObject({ error: code });
  });

  it('ignores errors that merely carry a 4xx status', () => {
    const capture = run({ status: 404, message: 'not really a parser error' });
    expect(capture.status()).toBe(500);
  });

  it('ignores non-object errors and out-of-range parser statuses', () => {
    expect(run('a string').status()).toBe(500);
    expect(run({ type: 'entity.parse.failed', status: 500 }).status()).toBe(500);
  });
});

describe('notFoundHandler', () => {
  it('answers with the method and path', () => {
    const capture = fakeResponse();
    notFoundHandler({ method: 'GET', path: '/v1/nope' } as unknown as Request, capture.res);
    expect(capture.status()).toBe(404);
    expect(capture.body()).toEqual({ error: 'not_found', message: 'no route for GET /v1/nope' });
  });
});

describe('asyncHandler', () => {
  it('routes a rejected handler to the error middleware', async () => {
    const next = jest.fn();
    const handler = asyncHandler(async () => {
      throw new Error('boom');
    });
    handler({} as Request, fakeResponse().res, next);
    await new Promise((resolve) => setImmediate(resolve));
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });

  it('does not call next when the handler succeeds', async () => {
    const next = jest.fn();
    const capture = fakeResponse();
    const handler = asyncHandler(async (_req, res) => {
      res.status(204).json({});
    });
    handler({} as Request, capture.res, next);
    await new Promise((resolve) => setImmediate(resolve));
    expect(next).not.toHaveBeenCalled();
    expect(capture.status()).toBe(204);
  });
});