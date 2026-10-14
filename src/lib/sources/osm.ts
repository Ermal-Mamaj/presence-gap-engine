import type { BusinessSource, RawBusiness, SearchBox } from "./types";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

// Overpass is told to give up after 25s server-side (see buildOverpassQuery);
// the client waits a little longer so it sees that answer instead of a hang.
const NOMINATIM_TIMEOUT_MS = 15_000;
const OVERPASS_TIMEOUT_MS = 40_000;

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
  optician: ["shop=optician"],
  "beauty salon": ["shop=beauty"],
  "nail salon": ["shop=beauty"],
  tattoo: ["shop=tattoo"],
  "car wash": ["amenity=car_wash"],
  "car dealer": ["shop=car"],
  "car rental": ["amenity=car_rental"],
  "driving school": ["amenity=driving_school"],
  kindergarten: ["amenity=kindergarten"],
  "language school": ["amenity=language_school"],
  "travel agency": ["shop=travel_agency"],
  insurance: ["office=insurance"],
  notary: ["office=notary"],
  architect: ["office=architect"],
  photographer: ["craft=photographer", "shop=photo"],
  tailor: ["craft=tailor", "shop=tailor"],
  carpenter: ["craft=carpenter"],
  painter: ["craft=painter"],
  locksmith: ["craft=locksmith", "shop=locksmith"],
  physiotherapist: ["healthcare=physiotherapist"],
  "fast food": ["amenity=fast_food"],
  pub: ["amenity=pub"],
  nightclub: ["amenity=nightclub"],
  "guest house": ["tourism=guest_house"],
  hostel: ["tourism=hostel"],
  butcher: ["shop=butcher"],
  supermarket: ["shop=supermarket"],
  jewelry: ["shop=jewelry"],
  furniture: ["shop=furniture"],
  hardware: ["shop=hardware"],
  electronics: ["shop=electronics"],
  "phone shop": ["shop=mobile_phone"],
  clothes: ["shop=clothes"],
  bookshop: ["shop=books"],
  "pet shop": ["shop=pet"],
  bicycle: ["shop=bicycle"],
  laundry: ["shop=laundry", "shop=dry_cleaning"],
  vet: ["amenity=veterinary"],
  veterinarian: ["amenity=veterinary"],
  realestate: ["office=estate_agent"],
  "real estate": ["office=estate_agent"],
};

async function geocodeRegion(region: string): Promise<{ lat: number; lon: number; boundingbox: [string, string, string, string] } | null> {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", region);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");

  const res = await fetch(url.toString(), {
    headers: {
      // Nominatim usage policy requires a descriptive User-Agent.
      "User-Agent": "presence-gap-engine/0.1 (lead-research tool)",
    },
    signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Nominatim error: ${res.status} ${res.statusText}`);
  const results = (await res.json()) as Array<{
    lat: string;
    lon: string;
    boundingbox: [string, string, string, string];
  }>;
  if (!Array.isArray(results) || !results.length) return null;
  const r = results[0];
  const lat = parseFloat(r.lat);
  const lon = parseFloat(r.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Array.isArray(r.boundingbox) || r.boundingbox.length !== 4) {
    throw new Error("Nominatim returned an unexpected response");
  }
  return { lat, lon, boundingbox: r.boundingbox };
}

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

// One OSM tag, as OSM writes it: "shop=optician", "healthcare=physiotherapist".
const RAW_TAG = /^[a-z][a-z0-9_:]*=[a-z0-9_:-]+$/i;
const MAX_RAW_TAGS = 5;

/**
 * The OSM tags for a niche: a known term ("dentist", "dentists"), or OSM tags
 * given directly ("shop=optician", or several separated by commas) for any
 * business type the table doesn't know. Empty when neither applies.
 */
export function tagsForNiche(niche: string): string[] {
  const key = niche.trim().toLowerCase();
  // Own keys only: "constructor" is not a niche.
  const known = (k: string) => (Object.hasOwn(NICHE_TAGS, k) ? NICHE_TAGS[k] : undefined);
  // loose match, e.g. "dentists" -> "dentist"
  const fromTable = known(key) ?? (key.endsWith("s") ? known(key.slice(0, -1)) : undefined);
  if (fromTable) return fromTable;

  const raw = niche.split(",").map((t) => t.trim()).filter(Boolean);
  if (raw.length > 0 && raw.length <= MAX_RAW_TAGS && raw.every((t) => RAW_TAG.test(t))) return raw;
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

/**
 * One Overpass element as a raw business. OSM spells most contact keys two
 * ways ("phone" and "contact:phone"), so both are read; the values are free
 * text and get normalized by sanitizeRawBusiness, not here.
 */
export function elementToBusiness(el: OverpassElement): RawBusiness | null {
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
    phone: tags.phone ?? tags["contact:phone"] ?? tags["contact:mobile"] ?? tags.mobile,
    email: tags.email ?? tags["contact:email"],
    facebook: tags["contact:facebook"] ?? tags.facebook,
    instagram: tags["contact:instagram"] ?? tags.instagram,
    website: tags.website ?? tags["contact:website"],
    latitude: lat,
    longitude: lon,
    sourceRef: `osm:${el.type}/${el.id}`,
  };
}

export const osmSource: BusinessSource = {
  id: "OSM",
  // No lead cap of its own: the Overpass query returns at most 200 elements,
  // and the scan caps the expensive part, website checks, itself.
  async search({ region, niche, limit }: SearchBox): Promise<RawBusiness[]> {
    const tags = tagsForNiche(niche);
    if (!tags.length) {
      throw new Error(
        `No OSM tag mapping known for niche "${niche}". Use a known term such as "dentist", "restaurant", "optician" or "car wash", ` +
          `or give the OpenStreetMap tag directly, e.g. "shop=optician" (several can be separated by commas).`
      );
    }

    const geo = await geocodeRegion(region);
    if (!geo) {
      throw new Error(`Could not geocode region "${region}". Try a more specific place name.`);
    }

    const query = buildOverpassQuery(geo.boundingbox, tags);
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: query,
      signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Overpass API error: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { elements?: OverpassElement[]; remark?: string };
    if (!Array.isArray(data?.elements)) {
      throw new Error("Overpass API returned an unexpected response");
    }
    // On overload or timeout Overpass still answers 200, with a remark and
    // whatever it managed to collect. A silently truncated list would look
    // like a real (small) result, so treat it as a failure.
    if (data.remark && /runtime error|timed out|out of memory/i.test(data.remark)) {
      throw new Error(`Overpass API could not finish the query: ${data.remark}`);
    }

    const businesses: RawBusiness[] = [];
    const seen = new Set<string>();
    for (const el of data.elements) {
      const biz = elementToBusiness(el);
      if (!biz) continue;
      const dedupeKey = biz.name.toLowerCase() + (biz.address ?? "");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      businesses.push(biz);
      if (limit !== undefined && businesses.length >= limit) break;
    }
    return businesses;
  },
};
