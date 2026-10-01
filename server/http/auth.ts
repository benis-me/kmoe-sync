// Single-administrator authentication: argon2id password, opaque session cookie (hashed at rest), CSRF header token.
import { now, type DB } from '../db';
import { randomToken, safeEqual, sha256 } from '../lib/crypto';
import { AppError } from './errors';

export const SESSION_COOKIE = 'kmoesync_session';
const SESSION_DAYS = 30;

export interface Session { id: string; csrf: string }

export class AdminAuth {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  /** Password checks under way (each a deliberately slow argon2id, then the wait after a wrong password). */
  private checking = 0;
  constructor(private readonly db: DB, private readonly secureCookies: boolean) {}

  isSetUp() { return Boolean(this.db.query('SELECT 1 FROM admin WHERE id = 1').get()); }

  async setup(password: string) {
    if (this.isSetUp()) throw new AppError(409, 'already_set_up', '管理员已创建，请直接登录');
    this.db.run('INSERT INTO admin (id, password_hash, created_at, updated_at) VALUES (1, ?, ?, ?)', [await Bun.password.hash(password, 'argon2id'), now(), now()]);
  }

  /**
   * Slows guessing without locking anyone out: each wrong password from an address in the last 10 minutes adds half a
   * second to the next failure (max 8 s). Behind a reverse proxy all users share one address, so a lockout would let
   * anyone keep the real admin out.
   */
  private async fail(ip: string) {
    const entry = this.attempts.get(ip);
    if (!entry || entry.resetAt <= Date.now()) this.attempts.set(ip, { count: 1, resetAt: Date.now() + 600_000 });
    else entry.count++;
    await Bun.sleep(Math.min(8000, (this.attempts.get(ip)!.count - 1) * 500));
  }

  async verify(password: string, ip: string) {
    const row = this.db.query<{ password_hash: string }, []>('SELECT password_hash FROM admin WHERE id = 1').get();
    if (!row) throw new AppError(409, 'setup_required', '请先创建管理员密码');
    // At most two at once: guesses sent in parallel would get round the wait after each failure (and load the CPU).
    if (this.checking >= 2) throw new AppError(429, 'too_many_logins', '登录请求太多，请稍后再试');
    this.checking++;
    try {
      if (!await Bun.password.verify(password, row.password_hash)) { await this.fail(ip); throw new AppError(401, 'wrong_password', '密码错误'); }
    } finally { this.checking--; }
    this.attempts.delete(ip);
  }

  async changePassword(current: string, next: string, ip: string) {
    await this.verify(current, ip);
    this.db.run('UPDATE admin SET password_hash = ?, updated_at = ? WHERE id = 1', [await Bun.password.hash(next, 'argon2id'), now()]);
  }

  createSession(): { token: string; session: Session } {
    const token = randomToken(), csrf = randomToken(24);
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    this.db.run('INSERT INTO sessions (id, csrf, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', [sha256(token), csrf, now(), expires, now()]);
    this.db.run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
    return { token, session: { id: sha256(token), csrf } };
  }

  session(req: Request): Session | null {
    const token = cookieValue(req, SESSION_COOKIE);
    if (!token) return null;
    const row = this.db.query<{ id: string; csrf: string; expires_at: string; last_seen_at: string }, [string]>('SELECT id, csrf, expires_at, last_seen_at FROM sessions WHERE id = ?').get(sha256(token));
    if (!row || row.expires_at < now()) return null;
    // Sliding expiry, written at most once an hour.
    if (Date.now() - Date.parse(row.last_seen_at) > 3_600_000) {
      this.db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?', [now(), new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString(), row.id]);
    }
    return { id: row.id, csrf: row.csrf };
  }

  endSession(session: Session | null) { if (session) this.db.run('DELETE FROM sessions WHERE id = ?', [session.id]); }
  /** After a password change: sign out every other browser. */
  endOtherSessions(keep: Session | null) { this.db.run('DELETE FROM sessions WHERE id != ?', [keep?.id ?? '']); }

  checkCsrf(req: Request, session: Session) {
    const header = req.headers.get('x-csrf-token') ?? '';
    if (!safeEqual(header, session.csrf)) throw new AppError(403, 'csrf', '页面已过期，请刷新后重试');
  }

  cookie(token: string | null): string {
    const attributes = [`${SESSION_COOKIE}=${token ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? SESSION_DAYS * 86_400 : 0}`];
    if (this.secureCookies) attributes.push('Secure');
    return attributes.join('; ');
  }
}

export function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}
