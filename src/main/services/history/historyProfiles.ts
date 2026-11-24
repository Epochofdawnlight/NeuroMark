import { randomUUID } from 'node:crypto';
import { getDatabase } from '@main/database/client';

export const DEFAULT_HISTORY_TIMEOUT_SECONDS = 180;

export interface StoredHistoryProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  encryptedKey: string;
  timeoutSeconds: number;
  isDefault: boolean;
}

function table() {
  const db = getDatabase().$client;
  db.exec(`CREATE TABLE IF NOT EXISTS history_model_profiles (
    id TEXT PRIMARY KEY, profile_json TEXT NOT NULL, is_default INTEGER NOT NULL
  )`);
  return db;
}

export function readHistoryProfiles(): StoredHistoryProfile[] {
  const rows = table()
    .prepare(
      'SELECT profile_json, is_default FROM history_model_profiles ORDER BY is_default DESC, rowid',
    )
    .all() as { profile_json: string; is_default: number }[];
  return rows.map(({ profile_json, is_default }) => ({
    ...JSON.parse(profile_json),
    isDefault: Boolean(is_default),
  }));
}

export function writeHistoryProfile(
  profile: Omit<StoredHistoryProfile, 'id' | 'isDefault'>,
  id: string | undefined,
  makeDefault: boolean,
): StoredHistoryProfile {
  const db = table();
  const profiles = readHistoryProfiles();
  const previous = profiles.find((entry) => entry.id === id);
  if (id && !previous) throw new Error('找不到要更新的模型。');
  const isDefault =
    makeDefault || Boolean(previous?.isDefault) || !profiles.length;
  const record = { ...profile, id: id ?? randomUUID() };
  db.exec('SAVEPOINT history_profile_update');
  try {
    if (isDefault)
      db.prepare('UPDATE history_model_profiles SET is_default = 0').run();
    db.prepare(
      `INSERT INTO history_model_profiles (id, profile_json, is_default)
      VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      profile_json = excluded.profile_json, is_default = excluded.is_default`,
    ).run(record.id, JSON.stringify(record), Number(isDefault));
    db.exec('RELEASE history_profile_update');
  } catch (error) {
    db.exec(
      'ROLLBACK TO history_profile_update; RELEASE history_profile_update',
    );
    throw error;
  }
  return { ...record, isDefault };
}
