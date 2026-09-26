import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { DEMO, NETWORK, RELAYER_DIR } from './config.js';

// Every role and device has its own key. They are generated once per network
// and kept in relayer/.keys/ (git-ignored), so `npm run sweep` can return the
// MON afterwards.

export type Role = 'carrier' | 'customer_s1' | 'customer_s3' | 'customer_storm';

export interface DeviceId {
  key: string; // "s1/W02", "s3/LOCO", "storm/07"
  caseId: 's1' | 's3' | 'storm';
  wagon: string; // "W02", "LOCO", "07"
}

export function deviceIds(): DeviceId[] {
  const out: DeviceId[] = [];
  for (const caseId of ['s1', 's3'] as const) {
    for (const wagon of Object.keys(DEMO.cases[caseId].wagons)) out.push({ key: `${caseId}/${wagon}`, caseId, wagon });
    out.push({ key: `${caseId}/LOCO`, caseId, wagon: 'LOCO' });
  }
  for (let i = 0; i < DEMO.storm.wagons; i++) {
    const wagon = String(i + 1).padStart(2, '0');
    out.push({ key: `storm/${wagon}`, caseId: 'storm', wagon });
  }
  return out;
}

interface KeyFile {
  roles: Record<Role, `0x${string}`>;
  devices: Record<string, `0x${string}`>;
}

const file = resolve(RELAYER_DIR, '.keys', `${NETWORK.name}.json`);

function load(): KeyFile {
  // On a server the keys come from the RELAYER_KEYS secret: the content of
  // relayer/.keys/<network>.json written by `npm run setup` on your machine.
  if (process.env.RELAYER_KEYS) {
    const keys = JSON.parse(process.env.RELAYER_KEYS) as KeyFile;
    const missing = deviceIds().filter(d => !keys.devices?.[d.key]).map(d => d.key);
    if (!keys.roles || missing.length) throw new Error(`RELAYER_KEYS is incomplete (missing ${missing.join(', ') || 'roles'})`);
    return keys;
  }
  const stored: Partial<KeyFile> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const roles = { ...(stored.roles ?? {}) } as Record<Role, `0x${string}`>;
  const devices = { ...(stored.devices ?? {}) };
  let changed = !existsSync(file);
  for (const role of ['carrier', 'customer_s1', 'customer_s3', 'customer_storm'] as Role[]) {
    if (!roles[role]) {
      roles[role] = generatePrivateKey();
      changed = true;
    }
  }
  for (const { key } of deviceIds()) {
    if (!devices[key]) {
      devices[key] = generatePrivateKey();
      changed = true;
    }
  }
  const keys = { roles, devices };
  if (changed) {
    mkdirSync(resolve(RELAYER_DIR, '.keys'), { recursive: true });
    writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  }
  return keys;
}

const KEYS = load();

export const roleAccount = (role: Role): PrivateKeyAccount => privateKeyToAccount(KEYS.roles[role]);
export const deviceAccount = (key: string): PrivateKeyAccount => privateKeyToAccount(KEYS.devices[key]);
export const customerRole = (caseId: 's1' | 's3' | 'storm'): Role => `customer_${caseId}` as Role;

export function allAccounts(): { label: string; account: PrivateKeyAccount }[] {
  return [
    ...(['carrier', 'customer_s1', 'customer_s3', 'customer_storm'] as Role[]).map(r => ({ label: r, account: roleAccount(r) })),
    ...deviceIds().map(d => ({ label: d.key, account: deviceAccount(d.key) })),
  ];
}
