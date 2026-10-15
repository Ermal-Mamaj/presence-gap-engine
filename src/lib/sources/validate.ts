import { z } from "zod";
import { normalizeEmail, normalizeSocialUrl, type SocialNetwork } from "../contacts";
import type { RawBusiness } from "./types";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? undefined : v))
    .optional()
    .catch(undefined);

// Contact fields are normalized rather than just trimmed: an unusable value
// becomes unknown instead of a broken mailto: or profile link.
const email = z.string().optional().transform((v) => normalizeEmail(v)).catch(undefined);
const social = (network: SocialNetwork) =>
  z.string().optional().transform((v) => normalizeSocialUrl(v, network)).catch(undefined);

// A bad optional field (e.g. a rating of 47 from a scraping glitch) is dropped
// to "unknown" rather than rejecting the whole business. Only a missing name
// makes a record unusable.
const rawBusinessSchema = z.object({
  name: z.string().trim().min(1).max(200),
  address: optionalText(300),
  phone: optionalText(60),
  email,
  facebook: social("facebook"),
  instagram: social("instagram"),
  website: optionalText(2048),
  latitude: z.number().finite().min(-90).max(90).optional().catch(undefined),
  longitude: z.number().finite().min(-180).max(180).optional().catch(undefined),
  rating: z.number().finite().min(0).max(5).optional().catch(undefined),
  reviewCount: z.number().int().min(0).max(10_000_000).optional().catch(undefined),
  sourceRef: optionalText(2048),
});

export function sanitizeRawBusiness(raw: unknown): RawBusiness | null {
  const parsed = rawBusinessSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
