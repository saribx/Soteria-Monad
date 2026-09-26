import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Address } from 'viem';
import { ROOT } from './config.js';

export const DEPLOYMENTS_FILE = resolve(ROOT, 'data/monad/deployments.json');

export interface Deployment {
  rail: Address;
  teur: Address;
  chainId: number;
  deployedAt: string;
  block: number;
}

export function readDeployments(): Record<string, Deployment> {
  return existsSync(DEPLOYMENTS_FILE) ? JSON.parse(readFileSync(DEPLOYMENTS_FILE, 'utf8')) : {};
}
