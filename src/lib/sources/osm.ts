import { createGeocoder, fetchOverpass } from "./osmClient";
import type { BusinessSource, RawBusiness, SearchBox } from "./types";

const geocode = createGeocoder();

// Best-effort niche -> OSM tag mapping. Falls back to a free-text name/shop search
// when the niche isn't in the table, since OSM's tagging vocabulary is huge and
// inconsistent.
const NICHE_TAGS: Record<string, string[]> = {
  dentist: ["amenity=dentist"],
  doctor: ["amenity=doctors"],
  clinic: ["amenity=clinic"],
  hospital: ["amenity=hospital"],
  pharmacy: ["amenity=pharmacy"],
  lawyer: ["office=lawyer"],
  accountant: ["office=accountant"],
  restaurant: ["amenity=restaurant"],
  cafe: ["amenity=cafe"],
  bar: ["amenity=bar"],
  bakery: ["shop=bakery"],
  hairdresser: ["shop=hairdresser"],
  barber: ["shop=hairdresser"],
  salon: ["shop=beauty"],
  gym: ["leisure=fitness_centre"],
  hotel: ["tourism=hotel"],
  garage: ["shop=car_repair"],
  mechanic: ["shop=car_repair"],
  plumber: ["craft=plumber"],
  electrician: ["craft=electrician"],
  florist: ["shop=florist"],
  vet: ["amenity=veterinary"],
  veterinarian: ["amenity=veterinary"],
  realestate: ["office=estate_agent"],
  "real estate": ["office=estate_agent"],
};

function buildOverpassQuery(bbox: [string, string, string, string], tags: string[]) {
  // boundingbox from Nominatim is [south, north, west, east]
  const [south, north, west, east] = bbox;
  const bboxStr = `${south},${west},${north},${east}`;
  const clauses = tags
    .map((tag) => {
      const [k, v] = tag.split("=");
      return `node[${JSON.stringify(k)}=${JSON.stringify(v)}](${bboxStr});way[${JSON.stringify(k)}=${JSON.stringify(v)}](${bboxStr});`;
    })
    .join("\n");
  return `[out:json][timeout:25];(${clauses});out center tags 200;`;
}

function tagsForNiche(niche: string): string[] {
  const key = niche.trim().toLowerCase();
  if (NICHE_TAGS[key]) return NICHE_TAGS[key];
  // loose match, e.g. "dentists" -> "dentist"
  const singular = key.endsWith("s") ? key.slice(0, -1) : key;
  if (NICHE_TAGS[singular]) return NICHE_TAGS[singular];
  return [];
}

export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function elementToBusiness(el: OverpassElement): RawBusiness | null {
  const tags = el.tags ?? {};
  const name = tags.name;
  if (!name) return null;

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;

  const addressParts = [
    tags["addr:housenumber"],
    tags["addr:street"],
    tags["addr:city"],
  ].filter(Boolean);

  return {
    name,
    address: addressParts.length ? addressParts.join(" ") : undefined,
    phone: tags.phone ?? tags["contact:phone"],
    website: tags.website ?? tags["contact:website"],
    latitude: lat,
    longitude: lon,
    sourceRef: `osm:${el.type}/${el.id}`,
  };
}

export const osmSource: BusinessSource = {
  id: "OSM",
  async search({ region, niche, limit = 60 }: SearchBox): Promise<RawBusiness[]> {
    const tags = tagsForNiche(niche);
    if (!tags.length) {
      throw new Error(
        `No OSM tag mapping known for niche "${niche}". Try a common term like "dentist", "restaurant", "hairdresser", "lawyer", "gym", etc.`
      );
    }

    const geo = await geocode(region);
    if (!geo) {
      throw new Error(`Could not geocode region "${region}". Try a more specific place name.`);
    }

    const query = buildOverpassQuery(geo.boundingbox, tags);
    const elements = await fetchOverpass(query);

    const businesses: RawBusiness[] = [];
    const seen = new Set<string>();
    for (const el of elements) {
      const biz = elementToBusiness(el);
      if (!biz) continue;
      const dedupeKey = biz.name.toLowerCase() + (biz.address ?? "");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      businesses.push(biz);
      if (businesses.length >= limit) break;
    }
    return businesses;
  },
};
