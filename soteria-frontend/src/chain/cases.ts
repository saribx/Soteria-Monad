// Joins the chain view (cases, devices, shipments) with the fleet data.
import { SCENARIOS } from '../data/scenarios';
import { live } from './store';
import type { CaseId, DeviceMeta } from './types';

const PARTIES = import.meta.glob<{ party_id: string; display_name: string }>('../../../data/parties/*.json', {
  eager: true,
  import: 'default',
});

const partyName = (id: string) =>
  Object.values(PARTIES).find(p => p.party_id === id)?.display_name.replace(/\s*\(fictional\)/, '') ?? id;

export const assetIdOf = (caseId: CaseId) => {
  const s = SCENARIOS.find(x => x.case_id === caseId);
  return s ? `asset-${s.train_data.train_id.toLowerCase()}` : '';
};

export const caseOfAsset = (assetId?: string | null): CaseId | null => {
  const s = SCENARIOS.find(x => `asset-${x.train_data.train_id.toLowerCase()}` === assetId);
  return s && (s.case_id === 's1' || s.case_id === 's3') ? s.case_id : null;
};

export const caseOfShipment = (sid: unknown): CaseId | null => {
  const cases = live.state?.cases;
  if (!cases) return null;
  return (['s1', 's3'] as CaseId[]).find(c => cases[c].shipmentId === Number(sid)) ?? null;
};

export const customerOf = (caseId: CaseId | null) => {
  const spec = caseId ? live.hello?.demo.cases[caseId] : undefined;
  return spec ? partyName(spec.customer) : 'the customer';
};

export const devicesOf = (caseId: CaseId | 'storm'): DeviceMeta[] =>
  live.state?.devices.filter(d => d.caseId === caseId) ?? [];

export const eur = (n: number) => `€${Math.round(n).toLocaleString('en-US')}`;
export const shortHash = (h?: string) => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '');
