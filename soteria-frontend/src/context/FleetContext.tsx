import React, { createContext, useContext, useState, useEffect } from 'react';
import { FleetAsset, TransitRoute, IncidentAlert, FleetMetrics, AssetType } from '../types/fleet';
import { MOCK_ASSETS, MOCK_ROUTES, MOCK_INCIDENTS, MOCK_METRICS } from '../data/mockFleetData';
import { measuredCorridor } from '../map/railGeometry';
import { currentHeadAlong } from '../map/trainModel';
import { channels, live } from '../chain/store';
import { caseOfAsset } from '../chain/cases';
import type { CaseId, Phase } from '../chain/types';

// Where each demo train is in its story. Without a relayer the dashboard shows
// the recorded incident ('offline'); with one, damage, obstruction and the
// incident report only appear once the scenario has triggered them on chain.
type LivePhase = Phase | 'offline';

function readPhases(): Record<CaseId, LivePhase> {
  const st = live.relayer ? live.state : undefined;
  return { s1: st?.cases.s1.phase ?? 'offline', s3: st?.cases.s3.phase ?? 'offline' };
}

/** The asset as it looks in a phase, continuing from where the train is now. */
function assetInPhase(current: FleetAsset, caseId: CaseId, phase: LivePhase, simulating: boolean, speedFactor: number): FleetAsset {
  const base = MOCK_ASSETS.find(a => a.id === current.id);
  if (!base?.track || !current.track) return current;
  const line = measuredCorridor(base.track.corridorId);
  if (!line) return current;
  const spec = live.hello?.demo.cases[caseId];
  const now = Date.now();
  let head = currentHeadAlong(current, now, simulating, speedFactor);
  const stamp = new Date(now).toLocaleDateString('en-US') + ', ' + new Date(now).toLocaleTimeString('en-US');

  if (phase === 'offline' || phase === 'incident') {
    const speedKmh = phase === 'offline' ? base.speedKmh : spec?.speed_kmh.after ?? base.speedKmh;
    return {
      ...base,
      speedKmh,
      coordinates: line.pointAt(head),
      heading: Math.round(line.bearingAt(head)),
      updatedAt: phase === 'incident' ? stamp : base.updatedAt,
      track: { ...base.track, headAlongM: head, updatedAtMs: now },
    };
  }

  // Before the incident: a train waiting to leave starts behind the incident site
  const behind = spec?.start_behind_m;
  if (behind && phase === 'idle') head = base.track.headAlongM - behind;
  const speedKmh = behind && phase === 'idle' ? 0 : spec?.speed_kmh.before ?? base.speedKmh;
  return {
    ...base,
    status: 'online',
    statusText: phase === 'idle'
      ? (speedKmh ? 'Running normally' : `Ready to depart ${base.origin}`)
      : 'Running normally · sensitive wagons report to Monad',
    speedKmh,
    delayMin: 0,
    nextStation: 'On schedule',
    cargoIntegrityPct: 100,
    currentTempC: base.targetTempC,
    coordinates: line.pointAt(head),
    heading: Math.round(line.bearingAt(head)),
    compartments: base.compartments.map(c => ({ ...c, status: 'nominal', temp: c.temp !== undefined ? base.targetTempC : undefined })),
    wagons: base.wagons?.map(w => ({ ...w, damaged: false, damage: undefined })),
    updatedAt: stamp,
    track: { ...base.track, headAlongM: head, updatedAtMs: now, trackBlocked: false, obstruction: undefined },
  };
}

interface FleetContextType {
  assets: FleetAsset[];
  routes: TransitRoute[];
  incidents: IncidentAlert[];
  activeIncident: IncidentAlert | null;
  metrics: FleetMetrics;
  selectedAsset: FleetAsset | null;
  hoveredAsset: FleetAsset | null;
  selectedIncident: IncidentAlert | null;
  isNotificationSidebarOpen: boolean;
  filterType: 'all' | 'train' | 'truck' | 'in_operation' | 'out_of_service';
  is3DMode: boolean;
  isSimulating: boolean;
  simulationSpeed: number;
  focusedCoordinates: [number, number] | null;

  // Actions
  selectAsset: (asset: FleetAsset | null) => void;
  setHoveredAsset: (asset: FleetAsset | null) => void;
  selectIncident: (incident: IncidentAlert | null) => void;
  toggleNotificationSidebar: () => void;
  closeNotificationSidebar: () => void;
  updateAsset: (id: string, updates: Partial<FleetAsset>) => void;
  deleteAsset: (id: string) => void;
  setFilterType: (filter: 'all' | 'train' | 'truck' | 'in_operation' | 'out_of_service') => void;
  toggle3DMode: () => void;
  toggleSimulation: () => void;
  setSimulationSpeed: (speed: number) => void;
  focusOnAsset: (asset: FleetAsset) => void;
}

const FleetContext = createContext<FleetContextType | undefined>(undefined);

export const FleetProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [assets, setAssets] = useState<FleetAsset[]>(MOCK_ASSETS);
  const [routes] = useState<TransitRoute[]>(MOCK_ROUTES);
  const [recordedIncidents] = useState<IncidentAlert[]>(MOCK_INCIDENTS);
  const [phases, setPhases] = useState<Record<CaseId, LivePhase>>(readPhases);

  // Follow the scenario phases (only re-render when a phase actually changes)
  useEffect(() => {
    const unsubscribe = channels.state.subscribe(() => {
      const next = readPhases();
      setPhases(prev => (prev.s1 === next.s1 && prev.s3 === next.s3 ? prev : next));
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // An incident is reported once it has happened
  const incidents = recordedIncidents
    .filter(i => {
      const c = caseOfAsset(i.assetId);
      return !c || phases[c] === 'offline' || phases[c] === 'incident';
    })
    .map(i => {
      const c = caseOfAsset(i.assetId);
      return c && phases[c] === 'incident' ? { ...i, timeAgo: 'just now' } : i;
    });
  const [selectedAsset, setSelectedAsset] = useState<FleetAsset | null>(null);
  const [hoveredAsset, setHoveredAsset] = useState<FleetAsset | null>(null);
  const [selectedIncident, setSelectedIncident] = useState<IncidentAlert | null>(null);

  // Operator switches incidents by selecting a train; otherwise the newest incident is shown
  const activeIncident =
    incidents.find(i => selectedAsset && i.assetId === selectedAsset.id) ?? selectedIncident ?? incidents[0] ?? null;

  // Tell an open dev console (console.html) which incident the operator is looking at
  useEffect(() => {
    if (!activeIncident || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('soteria-console');
    channel.postMessage({ incidentId: activeIncident.id });
    channel.close();
  }, [activeIncident?.id]);

  const [isNotificationSidebarOpen, setIsNotificationSidebarOpen] = useState<boolean>(false);
  const [filterType, setFilterType] = useState<'all' | 'train' | 'truck' | 'in_operation' | 'out_of_service'>('all');
  const [is3DMode, setIs3DMode] = useState<boolean>(true);
  const [isSimulating, setIsSimulating] = useState<boolean>(true);
  const [simulationSpeed, setSimulationSpeed] = useState<number>(1);
  const [focusedCoordinates, setFocusedCoordinates] = useState<[number, number] | null>(null);

  const toggleNotificationSidebar = () => {
    setIsNotificationSidebarOpen(prev => !prev);
  };

  const closeNotificationSidebar = () => {
    setIsNotificationSidebarOpen(false);
  };

  // Dynamic metrics calculation (derived live from the real asset & incident data)
  // A train with a warning still runs; only a critical ('offline') one is out of service
  const inOperationCount = assets.filter(a => a.status !== 'offline').length;
  const outOfServiceCount = assets.filter(a => a.status === 'offline').length;
  const trainsCount = assets.filter(a => a.type === 'train').length;
  const trucksCount = assets.filter(a => a.type === 'truck').length;
  const wagonsInTransit = assets.reduce((sum, a) => sum + a.compartments.length, 0);

  const metrics: FleetMetrics = {
    ...MOCK_METRICS,
    totalVehicles: assets.length,
    trainsCount,
    trucksCount,
    inOperationCount,
    outOfServiceCount,
    wagonsInTransit,
    activeIncidentsCount: incidents.length,
  };



  // Update Asset Handler
  const updateAsset = (id: string, updates: Partial<FleetAsset>) => {
    setAssets(prev => prev.map(item => {
      if (item.id === id) {
        const updated = {
          ...item,
          ...updates,
          updatedAt: new Date().toLocaleDateString('en-US') + ', ' + new Date().toLocaleTimeString('en-US'),
        };
        if (selectedAsset?.id === id) {
          setSelectedAsset(updated);
        }
        return updated;
      }
      return item;
    }));
  };

  // Delete Asset Handler
  const deleteAsset = (id: string) => {
    setAssets(prev => prev.filter(item => item.id !== id));
    if (selectedAsset?.id === id) {
      setSelectedAsset(null);
    }
  };

  const handleSelectAsset = (asset: FleetAsset | null) => {
    setSelectedAsset(asset);
    if (asset) {
      setFocusedCoordinates([...asset.coordinates] as [number, number]);
    } else {
      setFocusedCoordinates(null);
    }
  };

  // Focus on asset and zoom map
  const focusOnAsset = (asset: FleetAsset) => {
    handleSelectAsset(asset);
  };



  const toggle3DMode = () => {
    setIs3DMode(prev => !prev);
  };

  const toggleSimulation = () => {
    setIsSimulating(prev => !prev);
  };

  // Live simulation tick: trains drive along the real track at their reported
  // speed. The map extrapolates between ticks, so this only needs to be coarse.
  useEffect(() => {
    if (!isSimulating) return;

    const interval = setInterval(() => {
      const now = Date.now();
      setAssets(prevAssets =>
        prevAssets.map(asset => {
          if (!asset.track || asset.speedKmh === 0) return asset;
          const line = measuredCorridor(asset.track.corridorId);
          if (!line) return asset;
          const head = currentHeadAlong(asset, now, true, simulationSpeed);
          return {
            ...asset,
            coordinates: line.pointAt(head),
            heading: Math.round(line.bearingAt(head)),
            track: { ...asset.track, headAlongM: head, updatedAtMs: now },
          };
        })
      );
    }, 1000);

    return () => {
      clearInterval(interval);
      // Freeze trains where they are when the simulation pauses or changes speed
      const now = Date.now();
      setAssets(prev => prev.map(asset => asset.track && asset.speedKmh > 0
        ? { ...asset, track: { ...asset.track, headAlongM: currentHeadAlong(asset, now, true, simulationSpeed), updatedAtMs: now } }
        : asset));
    };
  }, [isSimulating, simulationSpeed]);

  // Damage, obstruction and speed follow the phase of each demo train
  useEffect(() => {
    const next = assets.map(asset => {
      const c = caseOfAsset(asset.id);
      return c ? assetInPhase(asset, c, phases[c], isSimulating, simulationSpeed) : asset;
    });
    setAssets(next);
    setSelectedAsset(sel => (sel ? next.find(a => a.id === sel.id) ?? sel : sel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phases.s1, phases.s3]);

  return (
    <FleetContext.Provider
      value={{
        assets,
        routes,
        incidents,
        activeIncident,
        metrics,
        selectedAsset,
        hoveredAsset,
        selectedIncident,
        isNotificationSidebarOpen,
        filterType,
        is3DMode,
        isSimulating,
        simulationSpeed,
        focusedCoordinates,
        selectAsset: handleSelectAsset,
        setHoveredAsset,
        selectIncident: setSelectedIncident,
        toggleNotificationSidebar,
        closeNotificationSidebar,
        updateAsset,
        deleteAsset,
        setFilterType,
        toggle3DMode,
        toggleSimulation,
        setSimulationSpeed,
        focusOnAsset,
      }}
    >
      {children}
    </FleetContext.Provider>
  );
};

export const useFleet = () => {
  const context = useContext(FleetContext);
  if (!context) {
    throw new Error('useFleet must be used within a FleetProvider');
  }
  return context;
};
