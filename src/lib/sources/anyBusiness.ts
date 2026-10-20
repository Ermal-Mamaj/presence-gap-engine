/**
 * "Anything" as a business type: every common kind of local business at once,
 * for a campaign that wants all of a town's businesses rather than one trade.
 * Each source turns it into what it can search: several Google Maps searches,
 * or a union of OpenStreetMap tags.
 */

// What people type for "any business", in English and Albanian.
const ANY_BUSINESS_WORDS = new Set([
  "anything",
  "any",
  "any business",
  "all",
  "all businesses",
  "everything",
  "*",
  "cdo",
  "cdo biznes",
  "te gjitha",
  "te gjitha bizneset",
]);

export function isAnyBusiness(niche: string): boolean {
  const key = niche
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return ANY_BUSINESS_WORDS.has(key);
}

/**
 * The Google Maps searches that stand for "anything": local businesses that
 * usually run themselves, the kind that might pay for a website. Banks, fuel
 * stations and chains are left out; they have head offices that do that.
 */
export const ANY_BUSINESS_SEARCHES = [
  "restaurant",
  "cafe",
  "bar",
  "fast food",
  "bakery",
  "supermarket",
  "clothing store",
  "beauty salon",
  "barber shop",
  "car repair",
  "car wash",
  "dentist",
  "pharmacy",
  "doctor",
  "gym",
  "hotel",
  "furniture store",
  "electronics store",
  "hardware store",
  "jewelry store",
  "florist",
  "real estate agency",
  "driving school",
  "lawyer",
];

/** The OpenStreetMap tags that stand for "anything": every shop, craft and office, and the amenities worth a pitch. */
export const ANY_BUSINESS_TAGS = [
  "shop=*",
  "craft=*",
  "office=*",
  "amenity=restaurant",
  "amenity=cafe",
  "amenity=bar",
  "amenity=pub",
  "amenity=fast_food",
  "amenity=dentist",
  "amenity=doctors",
  "amenity=clinic",
  "amenity=pharmacy",
  "amenity=veterinary",
  "amenity=driving_school",
  "amenity=car_wash",
  "amenity=car_rental",
  "leisure=fitness_centre",
  "tourism=hotel",
  "tourism=guest_house",
];
