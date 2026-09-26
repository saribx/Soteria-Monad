import React, { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import {
  Plus,
  Minus,
  Compass,
  RotateCw,
  Sunrise,
  Sun,
  Sunset,
  Moon,
  Map,
  Globe,
  Maximize,
  Minimize,
} from 'lucide-react';
import { useFleet } from '../../context/FleetContext';
import { FleetAsset } from '../../types/fleet';
import { INITIAL_MAP_CENTER, INITIAL_MAP_ZOOM, INITIAL_MAP_PITCH, INITIAL_MAP_BEARING, INITIAL_FOCUS_ASSET_ID } from '../../data/mockFleetData';
import { measuredCorridor } from '../../map/railGeometry';
import { currentHeadAlong, layoutTrain } from '../../map/trainModel';
import { addSoteriaLayers, buildDynamicData, setDynamicData, TRAIN_HIT_LAYERS } from '../../map/soteriaLayers';

// Mapbox Standard (3D buildings, landmark models, 3D trees, terrain) needs a
// personal access token: free tier, 50k map loads / month. Put it in
// soteria-frontend/.env.local as VITE_MAPBOX_ACCESS_TOKEN=pk.... Without one we
// fall back to keyless satellite imagery + OpenStreetMap building extrusions,
// because the Mapbox demo token below cannot load Mapbox tiles outside mapbox.com.
const USER_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN;
const DEMO_TOKEN = 'pk.eyJ1IjoibWFwYm94IiwiYSI6ImNpejY4NXVycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw';
const HAS_MAPBOX_3D = Boolean(USER_TOKEN);

type LightPreset = 'dawn' | 'day' | 'dusk' | 'night';
const LIGHT_PRESETS: { id: LightPreset; label: string; Icon: typeof Sun }[] = [
  { id: 'night', label: 'Night', Icon: Moon },
  { id: 'dusk', label: 'Dusk', Icon: Sunset },
  { id: 'dawn', label: 'Dawn', Icon: Sunrise },
  { id: 'day', label: 'Day', Icon: Sun },
];

// Keyless fallback: dark-graded satellite imagery with OSM glyphs for labels
const DARK_SATELLITE_STYLE: mapboxgl.StyleSpecification = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    'satellite-tiles': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© Esri World Imagery',
    },
    'dark-overlay-tiles': {
      type: 'raster',
      tiles: [
        'https://a.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}@2x.png',
      ],
      tileSize: 256,
    },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#080808',
      },
    },
    {
      id: 'satellite-base',
      type: 'raster',
      source: 'satellite-tiles',
      paint: {
        'raster-saturation': -0.45,
        'raster-contrast': 0.45,
        'raster-brightness-max': 0.78,
        'raster-brightness-min': 0.04,
        'raster-hue-rotate': -10,
      },
    },
    {
      id: 'labels-overlay',
      type: 'raster',
      source: 'dark-overlay-tiles',
      paint: {
        'raster-opacity': 0.65,
      },
    },
  ],
};

// Real relief everywhere, gently exaggerated only when zoomed far out so the
// Alps / Sierra read on the globe, true scale up close next to buildings.
const TERRAIN_EXAGGERATION: mapboxgl.ExpressionSpecification = [
  'interpolate', ['linear'], ['zoom'], 4, 1.8, 10, 1.3, 14, 1.0,
];

// Camera that frames a whole train from the side, looking along the track.
function trainCamera(asset: FleetAsset, head: number) {
  const line = measuredCorridor(asset.track!.corridorId)!;
  const length = layoutTrain(asset).lengthM;
  const middle = head - length / 2;
  return {
    center: line.pointAt(middle),
    bearing: line.bearingAt(middle) - 62,
    zoom: length > 200 ? 17.4 : 17.7,
    pitch: 66,
    // keep the train clear of the left dashboard column and bottom panels
    padding: { left: 430, right: 60, top: 80, bottom: 200 },
  };
}

interface InteractiveMap3DProps {
  isMapOnlyMode?: boolean;
  toggleMapOnlyMode?: () => void;
}

export const InteractiveMap3D: React.FC<InteractiveMap3DProps> = ({ isMapOnlyMode, toggleMapOnlyMode }) => {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<{ [id: string]: mapboxgl.Marker }>({});

  const {
    assets,
    selectedAsset,
    selectAsset,
    setHoveredAsset,
    focusedCoordinates,
    is3DMode,
    toggle3DMode,
    isSimulating,
    simulationSpeed,
  } = useFleet();

  const [mapLoaded, setMapLoaded] = useState(false);
  const [lightPreset, setLightPreset] = useState<LightPreset>('night');
  const [zoomedIn, setZoomedIn] = useState(false);
  const [satellite, setSatellite] = useState(true);
  // Mapbox Standard needs a valid token; if Mapbox rejects it, rebuild the map
  // with the keyless fallback instead of leaving it blank.
  const [useMapbox3D, setUseMapbox3D] = useState(HAS_MAPBOX_3D);
  const [tokenRejected, setTokenRejected] = useState(false);
  const [farOut, setFarOut] = useState(INITIAL_MAP_ZOOM < 7);

  // Latest state for the animation loop and map event handlers
  const live = useRef({ assets, isSimulating, simulationSpeed, selectAsset, setHoveredAsset });
  live.current = { assets, isSimulating, simulationSpeed, selectAsset, setHoveredAsset };

  const headOf = (asset: FleetAsset, atMs = Date.now()) =>
    currentHeadAlong(asset, atMs, live.current.isSimulating, live.current.simulationSpeed);

  // Id of a moving train the camera keeps framed until the user takes over
  const followRef = useRef<string | null>(null);
  const orbitRef = useRef<boolean>(false);
  const flightIdRef = useRef<number>(0);

  // Initialize Mapbox Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    mapboxgl.accessToken = useMapbox3D && USER_TOKEN ? USER_TOKEN : DEMO_TOKEN;
    setMapLoaded(false);

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: useMapbox3D ? 'mapbox://styles/mapbox/standard' : DARK_SATELLITE_STYLE,
      ...(useMapbox3D
        ? {
            config: {
              basemap: {
                lightPreset: 'night',
                show3dObjects: true,
                show3dBuildings: true,
                show3dFacades: true,
                show3dLandmarks: true,
                show3dTrees: true,
                showTransitLabels: true,
                showPointOfInterestLabels: false,
              },
            },
          }
        : {}),
      center: INITIAL_MAP_CENTER,
      zoom: INITIAL_MAP_ZOOM,
      pitch: INITIAL_MAP_PITCH,
      bearing: INITIAL_MAP_BEARING,
      antialias: true,
      maxPitch: 85,
      // Flat world map instead of the globe Mapbox Standard defaults to
      projection: 'mercator',
    });

    // Open right on the focus scenario's train (data/scenarios.json "initial_focus")
    const focusAsset = live.current.assets.find(a => a.id === INITIAL_FOCUS_ASSET_ID && a.track);
    if (focusAsset) {
      map.jumpTo(trainCamera(focusAsset, headOf(focusAsset)));
      setZoomedIn(true);
      setFarOut(false);
    }

    mapRef.current = map;

    map.on('load', () => {
      if (useMapbox3D) {
        // Satellite photo as the ground texture under Standard's 3D buildings,
        // trees, roads and labels: photoreal terrain plus modelled cities.
        map.addSource('mapbox-satellite', { type: 'raster', url: 'mapbox://mapbox.satellite', tileSize: 256 });
        map.addLayer({
          id: 'satellite-ground',
          type: 'raster',
          source: 'mapbox-satellite',
          // 'middle' sits above Standard's land-use fills (which would hide the
          // photo in built-up areas) but below 3D buildings, trees and labels
          slot: 'middle',
          paint: {
            'raster-saturation': -0.15,
            'raster-contrast': 0.1,
            'raster-emissive-strength': 0.35,
          },
        } as mapboxgl.LayerSpecification);
        map.addSource('soteria-dem', {
          type: 'raster-dem',
          url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
          tileSize: 512,
          maxzoom: 14,
        });
      } else {
        // Public AWS Terrarium elevation tiles
        map.addSource('soteria-dem', {
          type: 'raster-dem',
          tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
          tileSize: 256,
          encoding: 'terrarium',
          maxzoom: 15,
        });
        map.addLayer({
          id: 'alpine-hillshade',
          type: 'hillshade',
          source: 'soteria-dem',
          paint: {
            'hillshade-exaggeration': 0.8,
            'hillshade-shadow-color': '#000000',
            'hillshade-highlight-color': '#3f3f46',
            'hillshade-accent-color': '#18181b',
          },
        }, 'labels-overlay');
        map.setFog({
          range: [-0.5, 12],
          color: '#0a0a0c',
          'horizon-blend': 0.15,
          'high-color': '#18181b',
          'space-color': '#050505',
          'star-intensity': 0.45,
        });
      }
      map.setTerrain({ source: 'soteria-dem', exaggeration: TERRAIN_EXAGGERATION });

      addSoteriaLayers(
        map,
        {
          standard: useMapbox3D,
          font: useMapbox3D ? ['DIN Pro Medium', 'Arial Unicode MS Regular'] : ['Noto Sans Bold'],
        },
      );
      setDynamicData(map, buildDynamicData(live.current.assets, headOf));
      setMapLoaded(true);
    });

    map.on('zoom', () => {
      setZoomedIn(map.getZoom() >= 14.5);
      setFarOut(map.getZoom() < 7);
    });

    const trainAt = (point: mapboxgl.Point) => {
      const layers = TRAIN_HIT_LAYERS.filter(id => map.getLayer(id));
      const hit = layers.length ? map.queryRenderedFeatures(point, { layers })[0] : undefined;
      const id = hit?.properties?.assetId;
      return id ? live.current.assets.find(a => a.id === id) ?? null : null;
    };

    // Clicking a 3D train selects it; clicking empty terrain deselects
    map.on('click', (e) => {
      live.current.selectAsset(trainAt(e.point));
    });

    // Any manual camera interaction ends follow mode
    const stopFollowing = () => { 
      followRef.current = null; 
      orbitRef.current = false;
    };
    map.on('dragstart', stopFollowing);
    map.on('wheel', stopFollowing);
    map.on('touchstart', stopFollowing);

    let hovered: string | null = null;
    map.on('mousemove', (e) => {
      const asset = trainAt(e.point);
      map.getCanvas().style.cursor = asset ? 'pointer' : '';
      if ((asset?.id ?? null) !== hovered) {
        hovered = asset?.id ?? null;
        live.current.setHoveredAsset(asset);
      }
    });

    map.on('error', (e) => {
      const status = (e.error as { status?: number } | undefined)?.status;
      if (useMapbox3D && (status === 401 || status === 403)) {
        console.warn('Mapbox rejected the access token; falling back to the keyless map.');
        setTokenRejected(true);
        setUseMapbox3D(false);
      }
    });

    return () => {
      map.remove();
      // markers belonged to the removed map
      markersRef.current = {};
    };
  }, [useMapbox3D]);

  // Rotate the map with the trackpad. Safari reports the real two-finger
  // rotation gesture; Chrome and Firefox do not expose it, so there a
  // horizontal two-finger swipe turns the map (vertical still zooms).
  useEffect(() => {
    const viewport = viewportRef.current;
    const map = mapRef.current;
    if (!viewport || !map) return;

    let lastCtrlWheel = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        lastCtrlWheel = performance.now(); // pinch-zoom, handled by Mapbox
        return;
      }
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.2) return;
      e.preventDefault();
      e.stopPropagation();
      map.setBearing(map.getBearing() + e.deltaX * 0.25);
    };

    type GestureEvent = UIEvent & { rotation: number; scale: number };
    let start = { bearing: 0, zoom: 0 };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      start = { bearing: map.getBearing(), zoom: map.getZoom() };
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      map.setBearing(start.bearing - g.rotation);
      // Safari may not also send ctrl+wheel for the pinch; zoom here then
      if (performance.now() - lastCtrlWheel > 150) map.setZoom(start.zoom + Math.log2(g.scale));
    };
    const prevent = (e: Event) => e.preventDefault();

    viewport.addEventListener('wheel', onWheel, { capture: true, passive: false });
    viewport.addEventListener('gesturestart', onGestureStart);
    viewport.addEventListener('gesturechange', onGestureChange);
    viewport.addEventListener('gestureend', prevent);
    return () => {
      viewport.removeEventListener('wheel', onWheel, { capture: true });
      viewport.removeEventListener('gesturestart', onGestureStart);
      viewport.removeEventListener('gesturechange', onGestureChange);
      viewport.removeEventListener('gestureend', prevent);
    };
  }, [mapLoaded]);

  // Drive the trains: moving trains glide along the track every frame, damage
  // halos and the closed-track warning pulse.
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    let frame = 0;
    let lastGeometry = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const { assets: current, isSimulating: running } = live.current;
      const moving = running && current.some(a => a.track && a.speedKmh > 0);
      if (moving && now - lastGeometry > 33) {
        lastGeometry = now;
        setDynamicData(map, buildDynamicData(current, headOf));
        const followed = followRef.current && current.find(a => a.id === followRef.current);
        if (followed && followed.track && (!map.isMoving() || orbitRef.current)) {
          map.setCenter(trainCamera(followed, headOf(followed)).center);
        }
        if (orbitRef.current) {
          map.setBearing(map.getBearing() + 0.1);
        }
      }
      const pulse = 0.5 + 0.5 * Math.sin(now / 320);
      if (map.getLayer('train-damage-halo')) map.setPaintProperty('train-damage-halo', 'circle-opacity', 0.25 + 0.55 * pulse);
      if (map.getLayer('track-blocked-glow')) map.setPaintProperty('track-blocked-glow', 'line-opacity', 0.25 + 0.6 * pulse);
      if (map.getLayer('route-remaining-glow')) map.setPaintProperty('route-remaining-glow', 'line-opacity', 0.5 + 0.3 * Math.sin(now / 700));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mapLoaded]);

  // Rebuild train geometry whenever the fleet data changes (status, edits, pause)
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    setDynamicData(mapRef.current, buildDynamicData(assets, headOf));
  }, [assets, mapLoaded, isSimulating]);

  // Origin and destination station of every train's run
  useEffect(() => {
    if (!mapLoaded || !mapRef.current) return;
    const map = mapRef.current;
    const stops: mapboxgl.Marker[] = [];
    for (const asset of live.current.assets) {
      const line = asset.track && measuredCorridor(asset.track.corridorId);
      if (!asset.track || !line) continue;
      for (const [role, stop] of [['origin', asset.track.origin], ['destination', asset.track.destination]] as const) {
        const el = document.createElement('div');
        el.className = `stop-marker stop-${role}`;
        const caption = role === 'origin' ? 'Origin' : 'Destination';
        const name = stop.isStation ? stop.name : `${role === 'origin' ? 'from' : 'to'} ${stop.name}`;
        el.innerHTML = `<div class="stop-label"><span class="stop-caption">${caption} · ${asset.name.replace('Freight train ', '')}</span><span class="stop-name"></span></div><div class="stop-stem"></div><div class="stop-dot"></div>`;
        el.querySelector('.stop-name')!.textContent = name;
        stops.push(new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat(line.pointAt(stop.alongM)).addTo(map));
      }
    }
    return () => stops.forEach(m => m.remove());
  }, [mapLoaded]);

  useEffect(() => {
    if (!mapLoaded || !useMapbox3D || !mapRef.current) return;
    mapRef.current.setConfigProperty('basemap', 'lightPreset', lightPreset);
  }, [lightPreset, mapLoaded]);

  useEffect(() => {
    if (!mapLoaded || !useMapbox3D || !mapRef.current) return;
    mapRef.current.setLayoutProperty('satellite-ground', 'visibility', satellite ? 'visible' : 'none');
  }, [satellite, mapLoaded]);

  // Update 3D camera pitch and terrain when toggled (not on first render)
  const firstModeRender = useRef(true);
  useEffect(() => {
    if (!mapRef.current) return;
    if (firstModeRender.current) {
      firstModeRender.current = false;
      return;
    }
    const map = mapRef.current;

    if (is3DMode) {
      if (map.getSource('soteria-dem')) {
        map.setTerrain({ source: 'soteria-dem', exaggeration: TERRAIN_EXAGGERATION });
      }
      map.easeTo({
        pitch: 64,
        duration: 1200,
      });
    } else {
      map.setTerrain(null);
      map.easeTo({
        pitch: 0,
        duration: 1200,
      });
    }
  }, [is3DMode]);

  // Fly in close enough to see the train on its track, framed from the side
  useEffect(() => {
    if (!mapRef.current || !focusedCoordinates) return;
    const asset = selectedAsset?.track ? selectedAsset : null;
    // A moving train is met where it will be when the flight lands, then followed
    const FLIGHT_MS = 5000;
    
    orbitRef.current = false;
    const flightId = Date.now();
    flightIdRef.current = flightId;

    followRef.current = asset && asset.speedKmh > 0 ? asset.id : null;
    const camera = asset
      ? trainCamera(asset, headOf(asset, Date.now() + FLIGHT_MS))
      : { center: focusedCoordinates, zoom: 13.5, pitch: 64, bearing: mapRef.current.getBearing(), padding: 0 };
    mapRef.current.flyTo({
      ...camera,
      pitch: is3DMode ? camera.pitch : 0,
      ...(asset ? { duration: FLIGHT_MS } : { speed: 1.1 }),
      curve: 1.5,
      essential: true,
    });

    if (asset) {
      mapRef.current.once('moveend', () => {
        if (flightIdRef.current === flightId) {
          orbitRef.current = true;
          // Keep following even if stationary to center the rotation
          followRef.current = asset.id; 
        }
      });
    }
  }, [focusedCoordinates]);

  // Synchronize 3D Markers on Map
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;

    // Track active IDs to clean up removed ones
    const activeIds = new Set<string>();

    assets.forEach((asset) => {
      activeIds.add(asset.id);
      const isSelected = selectedAsset?.id === asset.id;
      const isWarning = asset.status === 'warning';
      const isOffline = asset.status === 'offline';

      const pinColor = isOffline
        ? '#ef4444'
        : isWarning
          ? '#f59e0b'
          : asset.type === 'train'
            ? '#38bdf8'
            : asset.type === 'truck'
              ? '#10b981'
              : '#a855f7';

      if (markersRef.current[asset.id]) {
        // Update marker position
        markersRef.current[asset.id].setLngLat(asset.coordinates);

        // Update DOM element classes
        const el = markersRef.current[asset.id].getElement();
        // Toggle only our class: Mapbox keeps its own positioning classes on this element
        el.classList.toggle('is-selected', isSelected);
      } else {
        // Create new DOM marker element
        const el = document.createElement('div');
        el.className = `custom-map-marker ${isSelected ? 'is-selected' : ''}`;
        el.style.width = '38px';
        el.style.height = '38px';
        el.style.display = 'flex';
        el.style.alignItems = 'center';
        el.style.justifyContent = 'center';

        // Outer dashed radar orbit for selected asset (as seen in reference screenshot)
        if (isSelected) {
          const orbit = document.createElement('div');
          orbit.style.position = 'absolute';
          orbit.style.width = '110px';
          orbit.style.height = '110px';
          orbit.style.borderRadius = '50%';
          orbit.style.border = '1.5px dashed rgba(255, 255, 255, 0.45)';
          orbit.style.pointerEvents = 'none';
          orbit.style.animation = 'spinOrbit 40s linear infinite';
          el.appendChild(orbit);
        }

        const inner = document.createElement('div');
        inner.className = 'marker-pin-inner';
        inner.style.backgroundColor = 'rgba(18, 18, 20, 0.92)';
        inner.style.borderColor = pinColor;
        inner.style.boxShadow = `0 0 18px ${pinColor}`;

        // Pulse ring
        const ring = document.createElement('div');
        ring.className = 'marker-pulse-ring';
        ring.style.border = `2px solid ${pinColor}`;
        inner.appendChild(ring);

        // Icon representation
        const iconSvg = document.createElement('div');
        iconSvg.style.display = 'flex';
        iconSvg.style.color = pinColor;
        iconSvg.innerHTML = asset.type === 'train'
          ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="m8 19-2 3"/><path d="m18 22-2-3"/><circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/></svg>`
          : asset.type === 'truck'
            ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>`
            : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/><path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/><path d="M10 14h4"/><path d="M10 18h4"/></svg>`;
        inner.appendChild(iconSvg);

        el.appendChild(inner);

        // Click handler to select asset
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          selectAsset(asset);
        });

        // Hover handlers for sleek transparent popup on hover
        el.addEventListener('mouseenter', () => {
          setHoveredAsset(asset);
        });
        el.addEventListener('mouseleave', () => {
          setHoveredAsset(null);
        });

        const marker = new mapboxgl.Marker({ element: el, anchor: 'center' })
          .setLngLat(asset.coordinates)
          .addTo(map);

        markersRef.current[asset.id] = marker;
      }
    });

    // Remove orphaned markers
    Object.keys(markersRef.current).forEach((id) => {
      if (!activeIds.has(id)) {
        markersRef.current[id].remove();
        delete markersRef.current[id];
      }
    });
  }, [assets, selectedAsset, mapLoaded]);

  // Map controls
  const rotationCountRef = useRef(0);

  const handleRotate90 = () => {
    if (!mapRef.current) return;
    rotationCountRef.current += 1;
    const targetBearing = INITIAL_MAP_BEARING + rotationCountRef.current * 90;
    mapRef.current.easeTo({
      bearing: targetBearing,
      duration: 650,
      easing: (t) => t * (2 - t),
    });
  };

  const handleZoomIn = () => mapRef.current?.zoomIn({ duration: 300 });
  const handleZoomOut = () => mapRef.current?.zoomOut({ duration: 300 });
  const handleFitCenter = () => {
    rotationCountRef.current = 0;
    mapRef.current?.flyTo({
      center: INITIAL_MAP_CENTER,
      zoom: INITIAL_MAP_ZOOM,
      pitch: is3DMode ? INITIAL_MAP_PITCH : 0,
      bearing: INITIAL_MAP_BEARING,
      padding: 0,
      duration: 1200,
    });
  };

  const presetIndex = LIGHT_PRESETS.findIndex(p => p.id === lightPreset);
  const preset = LIGHT_PRESETS[presetIndex];
  const cycleLightPreset = () => setLightPreset(LIGHT_PRESETS[(presetIndex + 1) % LIGHT_PRESETS.length].id);

  return (
    <div ref={viewportRef} className={`map-viewport ${zoomedIn ? 'is-zoomed-in' : ''} ${farOut ? 'is-far-out' : ''}`}>
      {/* Mapbox container */}
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

      {!useMapbox3D && (
        <div className="map-token-hint" title="VITE_MAPBOX_ACCESS_TOKEN in soteria-frontend/.env.local">
          {tokenRejected
            ? 'Basic 3D · Mapbox rejected the access token, check it in your Mapbox account'
            : 'Basic 3D · add a Mapbox token for photoreal 3D buildings & trees'}
        </div>
      )}

      {/* Floating Map Navigation Controls (bottom right: overview, 90° rotate, zoom, layers, lighting, 2D/3D) */}
      <div className="map-control-tools">
        <button
          className="map-tool-btn"
          onClick={handleFitCenter}
          title="World overview"
        >
          <Compass size={18} />
        </button>
        <button
          className="map-tool-btn"
          onClick={handleRotate90}
          title="Rotate view by 90°"
        >
          <RotateCw size={16} />
        </button>
        <button
          className="map-tool-btn"
          onClick={handleZoomIn}
          title="Zoom In"
        >
          <Plus size={18} />
        </button>
        <button
          className="map-tool-btn"
          onClick={handleZoomOut}
          title="Zoom Out"
        >
          <Minus size={18} />
        </button>
        {useMapbox3D && (
          <button
            className="map-tool-btn"
            onClick={() => setSatellite(v => !v)}
            title={satellite ? 'Switch to map view' : 'Switch to satellite view'}
          >
            {satellite ? <Globe size={16} /> : <Map size={16} />}
          </button>
        )}
        {useMapbox3D && (
          <button
            className="map-tool-btn"
            onClick={cycleLightPreset}
            title={`Lighting: ${preset.label} (click to change)`}
          >
            <preset.Icon size={16} />
          </button>
        )}
        <button
          className="map-tool-btn"
          onClick={toggle3DMode}
          title={is3DMode ? 'Switch to 2D' : 'Switch to 3D'}
          style={{ fontWeight: 700, fontSize: '11px' }}
        >
          {is3DMode ? '3D' : '2D'}
        </button>
        {toggleMapOnlyMode && (
          <button
            className="map-tool-btn"
            onClick={toggleMapOnlyMode}
            title={isMapOnlyMode ? 'Map Only beenden (Panels einblenden)' : 'Map Only (Panels ausblenden)'}
          >
            {isMapOnlyMode ? <Minimize size={16} /> : <Maximize size={16} />}
          </button>
        )}
      </div>
    </div>
  );
};
