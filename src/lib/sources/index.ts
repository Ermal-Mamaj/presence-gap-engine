import { osmSource } from "./osm";
import { googleMapsScraperSource } from "./googleMapsScraper";
import type { BusinessSource } from "./types";

export type { BusinessSource, RawBusiness, SearchBox } from "./types";

export const sources: Record<string, BusinessSource> = {
  OSM: osmSource,
  GOOGLE_MAPS_SCRAPER: googleMapsScraperSource,
};

export function getSource(id: string): BusinessSource {
  const source = sources[id];
  if (!source) throw new Error(`Unknown source "${id}"`);
  return source;
}
