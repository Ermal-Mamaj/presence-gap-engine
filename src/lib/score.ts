import type { DetectedSignal } from "./detect";

export interface ScorableBusiness {
  rating?: number | null;
  reviewCount?: number | null;
  phone?: string | null;
}

/**
 * A business is worth chasing when it has BOTH a real gap (weak/missing web
 * presence) AND signs it's an actual, viable operation (reviews, rating,
 * a phone number people can reach). Gap alone isn't enough — a business with
 * zero reviews and no phone might just be a stale/defunct listing.
 */
export function computeScore(signals: DetectedSignal[], business: ScorableBusiness): number {
  const gapScore = signals.reduce((sum, s) => sum + s.severity, 0);
  if (gapScore === 0) return 0;

  const reviewCount = business.reviewCount ?? 0;
  const rating = business.rating ?? 0;

  // Diminishing-returns credit for review volume, capped so a mega-business
  // doesn't dwarf everything else.
  const reviewFactor = Math.min(Math.log10(reviewCount + 1) / Math.log10(200), 1) * 0.6;
  const ratingFactor = rating > 0 ? (rating / 5) * 0.3 : 0;
  const phoneFactor = business.phone ? 0.1 : 0;

  let viabilityMultiplier = 1 + reviewFactor + ratingFactor + phoneFactor;

  // Penalize likely-ghost listings: no reviews, no rating, no phone at all.
  if (reviewCount === 0 && rating === 0 && !business.phone) {
    viabilityMultiplier *= 0.5;
  }

  return Math.round(gapScore * viabilityMultiplier * 100) / 100;
}
