export interface RawBusiness {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  /** Profile URL or page name; normalized by sanitizeRawBusiness. */
  facebook?: string;
  /** Profile URL or handle; normalized by sanitizeRawBusiness. */
  instagram?: string;
  website?: string;
  latitude?: number;
  longitude?: number;
  rating?: number;
  reviewCount?: number;
  sourceRef?: string;
}

export interface SearchBox {
  region: string; // free-text place name, e.g. "Tirana, Albania"
  niche: string; // free-text business type, e.g. "dentist"
  limit?: number;
  /** Says what the search is doing now, for a scan that takes minutes. Optional to call. */
  onProgress?: (message: string) => void;
  /** Places this campaign already has (stable references, see stableSourceRef): a source may skip opening their details. */
  knownRefs?: ReadonlySet<string>;
}

export interface BusinessSource {
  id: "OSM" | "GOOGLE_MAPS_SCRAPER";
  search(box: SearchBox): Promise<RawBusiness[]>;
}
