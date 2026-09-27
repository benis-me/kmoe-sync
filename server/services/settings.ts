// App settings: one JSON value per key, with defaults. Also holds queue pause state and the API token hash.
import { Settings, type Channel, type PauseReason, type SettingsPatch } from '@shared/model';
import { json, type DB } from '../db';
import type { ThrottleState } from '../kmoe/client';

export type SettingsValue = Omit<Settings, 'apiToken'>;
export const DEFAULTS: SettingsValue = {
  checkIntervalHours: 6,
  concurrency: 2,
  autoRetry: true,
  maxRetries: 3,
  quotaReserveMB: 512,
  defaultFormat: 'epub',
  defaultLine: 0,
  defaultTargetId: null,
  preferredMirror: '',
  notifications: [] as Channel[],
  proxy: '',
  proxyKmoe: false,
};

export class SettingsStore {
  constructor(private readonly db: DB) {}

  private read<T>(key: string, fallback: T): T {
    const row = this.db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? json<T>(row.value, fallback) : fallback;
  }
  private write(key: string, value: unknown) {
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(value)]);
  }

  get(): SettingsValue {
    const stored = this.read<Partial<SettingsValue>>('app', {});
    return { ...DEFAULTS, ...stored };
  }
  view(): Settings {
    return Settings.parse({ ...this.get(), apiToken: Boolean(this.apiTokenHash()) });
  }
  patch(patch: SettingsPatch): SettingsValue {
    const next = { ...this.get(), ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as SettingsValue;
    this.write('app', next);
    return next;
  }

  apiTokenHash(): string | null { return this.read<string | null>('apiTokenHash', null); }
  setApiTokenHash(hash: string | null) { this.write('apiTokenHash', hash); }

  pause(): { reason: PauseReason | null; since: string | null } { return this.read('queuePause', { reason: null, since: null }); }
  setPause(reason: PauseReason | null) { this.write('queuePause', { reason, since: reason ? new Date().toISOString() : null }); }

  /** Kmoe's last block (see kmoe/client.ts), kept across restarts. */
  kmoeThrottle(): ThrottleState | null { return this.read<ThrottleState | null>('kmoeThrottle', null); }
  setKmoeThrottle(state: ThrottleState) { this.write('kmoeThrottle', state); }
}
