// The demo scenarios, assembled from the repository's single sources of truth:
//   data/<case>/<case>_train.json, <case>_incident.json   facts (shared with the backend)
//   data/scenarios.json                                   geography and presentation
// Change a scenario there; map, fleet tab, routes and incidents follow.
import MANIFEST from '../../../data/scenarios.json';
import type { TrainLivery } from '../types/fleet';

export interface RawWagon {
  wagon_id: string;
  wagon_type: 'standard' | 'refrigerated';
  cargo_class: string;
}

export interface RawTrain {
  train_id: string;
  locomotive: { position: string; cab: string };
  wagon_count: number;
  wagons: RawWagon[];
}

export interface RawIncident {
  incident_id: string;
  train_id: string;
  timestamp: string;
  location: string;
  reporter_role: string;
  incident_type: string;
  symptom: string;
  obstruction: {
    present: boolean;
    type: string;
    position: string;
    blocking_track: boolean;
  };
  affected_wagons: { wagon_id: string; damage_description: string }[];
  train_operational: 'normal' | 'restricted' | 'immobilized';
  track_blocked: boolean;
  severity: 'low' | 'medium' | 'high';
}

export interface JourneyStop {
  name: string; // shown in the fleet tab
  station?: string; // OSM station on the corridor where the map pins it
}

export interface ScenarioConfig {
  case_id: string;
  location_label: string;
  flag: string;
  route: { id: string; code: string; name: string; color: string };
  journey: {
    origin: JourneyStop;
    destination: JourneyStop;
    departure_time: string;
    arrival_time: string;
    route_length_km: number;
    travel_time_min: number;
    progress_pct: number;
  };
  train: { livery: TrainLivery; speed_kmh?: number };
  obstruction: { ahead_m: number; model: string } | null;
}

export interface Scenario extends ScenarioConfig {
  train_data: RawTrain;
  incident: RawIncident;
}

const TRAINS = import.meta.glob<RawTrain>('../../../data/s*/*_train.json', { eager: true, import: 'default' });
const INCIDENTS = import.meta.glob<RawIncident>('../../../data/s*/*_incident.json', { eager: true, import: 'default' });

function caseFile<T>(files: Record<string, T>, caseId: string, kind: string): T {
  const file = files[`../../../data/${caseId}/${caseId}_${kind}.json`];
  if (!file) throw new Error(`data/${caseId}/${caseId}_${kind}.json missing for scenario ${caseId}`);
  return file;
}

// Scenario the app opens on (null: world overview)
export const INITIAL_FOCUS_CASE: string | null = (MANIFEST as { initial_focus?: string | null }).initial_focus ?? null;

export const SCENARIOS: Scenario[] = (MANIFEST.scenarios as unknown as ScenarioConfig[]).map(config => ({
  ...config,
  train_data: caseFile(TRAINS, config.case_id, 'train'),
  incident: caseFile(INCIDENTS, config.case_id, 'incident'),
}));
