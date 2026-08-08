/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Tile URL template for the tracking map. Defaults to OpenStreetMap. Point at a keyed
   *  provider (Mapbox/MapTiler) for production. */
  readonly VITE_MAP_TILE_URL?: string;
  readonly VITE_MAP_ATTRIBUTION?: string;
  /** Origin of the Needy API. Baked in at build time by Vite, so an image built for one
   *  environment cannot be re-pointed at another with a runtime env var. */
  readonly VITE_API_URL?: string;
  /** Human help line offered in the crash fallback. Unset means the fallback speaks of a help
   *  line without printing a number, rather than offering one that rings nowhere. */
  readonly VITE_SUPPORT_PHONE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
