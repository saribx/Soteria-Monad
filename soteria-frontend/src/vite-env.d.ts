/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPBOX_ACCESS_TOKEN?: string;
  readonly VITE_SENSOR_RPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
