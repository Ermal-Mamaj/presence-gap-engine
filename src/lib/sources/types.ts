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
}

export interface BusinessSource {
  id: "OSM" | "GOOGLE_MAPS_SCRAPER";
  search(box: SearchBox): Promise<RawBusiness[]>;
}
