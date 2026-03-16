import type { LockedModeStatus } from '../skill/types.js';
import { Capability } from '../skill/types.js';
import { withTimeout } from '../core/utils.js';

export const SERVICE_NAME = 'schrute';

interface Keytar {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findPassword(service: string): Promise<string | null>;
}

let keytarModule: Keytar | null = null;
let keytarLoadFailed = false;
let keytarLoadError: string | null = null;

const KEYTAR_TIMEOUT_MS = 2000;

function withKeytarTimeout<T>(op: Promise<T>, label: string): Promise<T> {
  return withTimeout(op, KEYTAR_TIMEOUT_MS, label);
}

async function loadKeytar(): Promise<Keytar> {
  if (keytarModule) return keytarModule;
  if (keytarLoadFailed) {
    throw new Error(keytarLoadError ?? 'keytar failed to load previously');
  }

  try {
    const mod = await import('keytar');
    keytarModule = mod.default ?? mod;
    return keytarModule!;
  } catch (err) {
    keytarLoadFailed = true;
    keytarLoadError = getPlatformInstallInstructions(err);
    throw new Error(keytarLoadError);
  }
}

function getPlatformInstallInstructions(err: unknown): string {
  const baseMsg = `Failed to load keytar: ${err instanceof Error ? err.message : String(err)}`;

  if (process.platform === 'darwin') {
    return `${baseMsg}\nOn macOS, keytar should work out of the box. Ensure Keychain Access is available and the system keychain is unlocked.`;
  }
  if (process.platform === 'linux') {
    return `${baseMsg}\nOn Linux, keytar requires libsecret. Install it with:\n  Ubuntu/Debian: sudo apt install libsecret-1-dev\n  Fedora: sudo dnf install libsecret-devel\n  Arch: sudo pacman -S libsecret`;
  }
  if (process.platform === 'win32') {
    return `${baseMsg}\nOn Windows, keytar uses the Credential Vault. Ensure Windows Credential Manager is running.`;
  }
  return baseMsg;
}

function siteKey(siteId: string, type: string): string {
  return `site:${siteId}:${type}`;
}

export async function store(key: string, value: string): Promise<void> {
  const keytar = await loadKeytar();
  await withKeytarTimeout(keytar.setPassword(SERVICE_NAME, key, value), 'store');
}

export async function retrieve(key: string): Promise<string | null> {
  const keytar = await loadKeytar();
  return withKeytarTimeout(keytar.getPassword(SERVICE_NAME, key), 'retrieve');
}

export async function remove(key: string): Promise<boolean> {
  const keytar = await loadKeytar();
  return withKeytarTimeout(keytar.deletePassword(SERVICE_NAME, key), 'remove');
}

export async function exists(key: string): Promise<boolean> {
  const keytar = await loadKeytar();
  const val = await withKeytarTimeout(keytar.getPassword(SERVICE_NAME, key), 'exists');
  return val !== null;
}

export async function storeSiteSecret(siteId: string, type: string, value: string): Promise<void> {
  await store(siteKey(siteId, type), value);
}

export async function retrieveSiteSecret(siteId: string, type: string): Promise<string | null> {
  return retrieve(siteKey(siteId, type));
}

export async function removeSiteSecret(siteId: string, type: string): Promise<boolean> {
  return remove(siteKey(siteId, type));
}

export async function getLockedModeStatus(): Promise<LockedModeStatus> {
  const testKey = '__schrute_lock_test__';
  const testValue = 'test';

  try {
    const keytar = await loadKeytar();
    await withKeytarTimeout(keytar.setPassword(SERVICE_NAME, testKey, testValue), 'lock-test-set');
    await withKeytarTimeout(keytar.deletePassword(SERVICE_NAME, testKey), 'lock-test-del');

    return {
      locked: false,
      availableCapabilities: [
        Capability.SECRETS_USE,
        Capability.STORAGE_WRITE,
        Capability.NET_FETCH_DIRECT,
        Capability.NET_FETCH_BROWSER_PROXIED,
        Capability.BROWSER_AUTOMATION,
      ],
      unavailableCapabilities: [],
    };
  } catch (err) {
    return {
      locked: true,
      reason: `Keychain unavailable: ${err instanceof Error ? err.message : String(err)}`,
      availableCapabilities: [
        Capability.STORAGE_WRITE,
        Capability.NET_FETCH_DIRECT,
        Capability.NET_FETCH_BROWSER_PROXIED,
        Capability.BROWSER_AUTOMATION,
      ],
      unavailableCapabilities: [Capability.SECRETS_USE],
    };
  }
}
