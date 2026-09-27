// Form validation with the shared zod schemas: friendly Chinese messages and per-field errors.
import { z } from 'zod';

// Schema-level messages (e.g. 密码至少 8 位) still win; this covers the generic cases.
z.config({
  customError: issue => {
    if (issue.code === 'too_small' && issue.origin === 'string') return Number(issue.minimum) <= 1 ? '不能为空' : `至少 ${issue.minimum} 个字符`;
    if (issue.code === 'too_big' && issue.origin === 'string') return `最多 ${issue.maximum} 个字符`;
    if (issue.code === 'too_small' && issue.origin === 'array') return '至少选择一项';
    if (issue.code === 'too_small' || issue.code === 'too_big') return `超出允许的范围`;
    if (issue.code === 'invalid_format') return issue.format === 'url' ? '请输入完整的网址，例如 https://example.com' : issue.format === 'email' ? '请输入邮箱' : '格式不正确';
    return undefined;
  },
});

export type FieldErrors = Partial<Record<string, string>>;

/** The first message per top-level field. */
export function fieldErrors(error: z.ZodError): FieldErrors {
  const result: FieldErrors = {};
  for (const issue of error.issues) result[String(issue.path[0] ?? '')] ??= issue.message;
  return result;
}
