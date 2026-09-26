/** Browser-only private state shared by opt-in domain queues. Never place tokens here. */
export const PRIVATE_BROWSER_STORAGE_PREFIX = 'workout:private:';
export const PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY = `${PRIVATE_BROWSER_STORAGE_PREFIX}account-scope`;

type BrowserStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(storage?: BrowserStorage): BrowserStorage | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Clear opt-in health drafts on explicit logout, account switch or session loss. */
export function clearPrivateBrowserStorage(storage?: BrowserStorage): boolean {
  const target = browserStorage(storage);
  if (!target) return false;
  try {
    const keys: string[] = [];
    for (let index = 0; index < target.length; index += 1) {
      const key = target.key(index);
      if (key?.startsWith(PRIVATE_BROWSER_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) target.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** A prior account's pending commands must be removed before a new account mounts. */
export function bindPrivateBrowserStorageAccount(
  athleteId: string,
  storage?: BrowserStorage,
): boolean {
  const target = browserStorage(storage);
  if (!target || athleteId.length === 0 || athleteId.length > 200) return false;
  try {
    const previous = target.getItem(PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY);
    if (previous !== athleteId && !clearPrivateBrowserStorage(target)) return false;
    target.setItem(PRIVATE_BROWSER_ACCOUNT_SCOPE_KEY, athleteId);
    return true;
  } catch {
    return false;
  }
}
