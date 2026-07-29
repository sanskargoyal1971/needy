/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Tile URL template for the tracking map. Defaults to OpenStreetMap. Point at a keyed
   *  provider (Mapbox/MapTiler) for production. */
  readonly VITE_MAP_TILE_URL?: string;
  readonly VITE_MAP_ATTRIBUTION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
