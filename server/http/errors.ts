// Every failure becomes { error: { code, message } } with a meaningful status. Messages are user-facing Chinese.
import { ZodError } from 'zod';
import { NamingError } from '@shared/naming';
import { KmoeError } from '../kmoe/errors';
import { StorageError } from '../storage/types';

export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const KMOE_STATUS: Partial<Record<KmoeError['code'], number>> = {
  login_required: 409, invalid_credentials: 400, account_disabled: 403, login_challenge: 409, quota_exhausted: 409,
  refused: 409, not_found: 404, rate_limited: 429,
};

export function errorResponse(error: unknown): Response {
  let status = 500, code = 'internal_error', message = '服务器内部错误，请查看日志';
  if (error instanceof AppError) ({ status, code, message } = error);
  else if (error instanceof ZodError) {
    status = 400; code = 'invalid_request';
    const issue = error.issues[0];
    message = issue ? `${issue.path.length ? `${issue.path.join('.')}：` : ''}${issue.message}` : '请求参数无效';
  } else if (error instanceof KmoeError) { status = KMOE_STATUS[error.code] ?? 502; code = `kmoe_${error.code}`; message = error.message; }
  else if (error instanceof StorageError) { status = error.code === 'invalid' ? 400 : error.code === 'conflict' ? 409 : 502; code = `storage_${error.code}`; message = error.message; }
  else if (error instanceof NamingError) { status = 400; code = 'invalid_rule'; message = error.message; }
  else if (error instanceof SyntaxError) { status = 400; code = 'invalid_json'; message = '请求内容不是有效的 JSON'; }
  if (status >= 500 && !(error instanceof KmoeError) && !(error instanceof StorageError)) console.error(error);
  return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
}
