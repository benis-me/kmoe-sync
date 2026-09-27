// Display helpers: sizes, speeds, durations and times, in the app's short Chinese style.
import { formatBytes } from '@shared/naming';
import type { Format, Line } from '@shared/model';

export const MB = 1024 ** 2;
/** 500 MB · 1.5 GB (no trailing .0). */
export const formatMB = (mb: number) => formatBytes(mb * MB).replace('.0 ', ' ');
export const formatSpeed = (bytesPerSecond: number) => `${formatBytes(bytesPerSecond)}/s`;
export const FORMAT_LABELS: Record<Format, string> = { epub: 'EPUB', mobi: 'MOBI' };
export const LINE_LABELS: Record<Line, string> = { 0: '线路一', 1: '线路二' };

/** 45 秒 · 3 分钟 · 1 小时 20 分 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.round(seconds % 3600 / 60)} 分`;
}

/** 今天 14:32 · 昨天 09:10 · 9月12日 14:32 · 2025年9月12日 14:32 */
export function formatWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 864e5);
  if (days === 0) return `今天 ${clock}`;
  if (days === 1) return `昨天 ${clock}`;
  if (days === -1) return `明天 ${clock}`;
  const day = date.toLocaleDateString('zh-CN', { year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' });
  return `${day} ${clock}`;
}

/** 刚刚 · 3 分钟前 · 2 小时后 · 5 天前; older than a month falls back to the date. */
export function fromNow(iso: string, now = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000;
  const abs = Math.abs(seconds), suffix = seconds > 0 ? '后' : '前';
  if (abs < 60) return seconds > 0 ? '1 分钟内' : '刚刚';
  if (abs < 3600) return `${Math.round(abs / 60)} 分钟${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)} 小时${suffix}`;
  if (abs < 86400 * 30) return `${Math.round(abs / 86400)} 天${suffix}`;
  return formatWhen(iso);
}

export const percent = (part: number, total: number) => total > 0 ? Math.min(100, part / total * 100) : 0;

export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

/** Width-, case- and whitespace-insensitive (全角/半角 alike), for in-page filtering. */
export const searchKey = (text: string) => text.normalize('NFKC').replace(/\s/g, '').toLowerCase();
