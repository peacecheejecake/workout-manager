// Reads the git-ignored .env into a plain object. Never prints values.
import { readFileSync } from 'node:fs';
export const ENV_FILE = '/Users/minjiwon/workout-manager/.env';
export function loadEnv() {
  const out = {};
  for (const raw of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line
      .slice(0, i)
      .trim()
      .replace(/^export\s+/, '');
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}
