import type { DetectedSignal } from "./detect";

export interface ScorableBusiness {
  rating?: number | null;
  reviewCount?: number | null;
  phone?: string | null;
}

export const MAX_SCORE = 100;

// An uncertain signal (one failed request, say) counts for half: it is a lead
// worth a manual look, but not proof of a gap.
export const UNCERTAIN_WEIGHT = 0.5;

// Viability credit ceilings. Together with the 1.0 baseline they give a
// multiplier between 1.0 and 2.0 (0.5 to 1.0 with the ghost penalty).
const REVIEW_CREDIT = 0.6;
const RATING_CREDIT = 0.3;
const PHONE_CREDIT = 0.1;
const REVIEWS_FOR_FULL_CREDIT = 200;
const GHOST_PENALTY = 0.5;

export interface ScoreBreakdown {
  /** Severity-weighted sum of the detected signals. */
  gapPoints: number;
  reviewCredit: number;
  ratingCredit: number;
  phoneCredit: number;
  /** True when the source reported an empty listing and there is no phone. */
  ghostPenaltyApplied: boolean;
  viabilityMultiplier: number;
  /** Final score, finite and within [0, MAX_SCORE]. */
  score: number;
}

function isKnownNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasPhone(phone: string | null | undefined): boolean {
  return typeof phone === "string" && phone.trim() !== "";
}

/**
 * A business is worth chasing when it has BOTH a real gap (weak/missing web
 * presence) AND signs it's an actual, viable operation (reviews, rating,
 * a phone number people can reach). Gap alone isn't enough — a business with
 * zero reviews and no phone might just be a stale/defunct listing.
 *
 * Unknown is not zero. A missing review count or rating (the source never
 * reported one, as with OpenStreetMap) earns no credit but is not evidence of
 * an empty listing either. A reported 0 reviews / unrated listing is.
 */
export function explainScore(signals: DetectedSignal[], business: ScorableBusiness): ScoreBreakdown {
  const gapPoints = signals.reduce((sum, s) => {
    if (!isKnownNumber(s.severity) || s.severity <= 0) return sum;
    return sum + s.severity * (s.certainty === "UNCERTAIN" ? UNCERTAIN_WEIGHT : 1);
  }, 0);

  const reviewCount = isKnownNumber(business.reviewCount) && business.reviewCount >= 0 ? business.reviewCount : null;
  // A rating outside 0-5 is corrupt data; ignore it rather than reward it.
  const rating = isKnownNumber(business.rating) && business.rating >= 0 && business.rating <= 5 ? business.rating : null;
  const phone = hasPhone(business.phone);

  // Diminishing-returns credit for review volume, capped so a mega-business
  // doesn't dwarf everything else.
  const reviewCredit =
    reviewCount && reviewCount > 0
      ? Math.min(Math.log10(reviewCount + 1) / Math.log10(REVIEWS_FOR_FULL_CREDIT), 1) * REVIEW_CREDIT
      : 0;
  const ratingCredit = rating && rating > 0 ? (rating / 5) * RATING_CREDIT : 0;
  const phoneCredit = phone ? PHONE_CREDIT : 0;

  // Penalize likely-ghost listings: the source reported no reviews and no
  // rating, and there is no phone either. Unknown values don't trigger this.
  const reportedEmpty = (reviewCount === 0 || rating === 0) && !(reviewCount && reviewCount > 0) && !(rating && rating > 0);
  const ghostPenaltyApplied = reportedEmpty && !phone;

  let viabilityMultiplier = 1 + reviewCredit + ratingCredit + phoneCredit;
  if (ghostPenaltyApplied) viabilityMultiplier *= GHOST_PENALTY;

  const raw = gapPoints === 0 ? 0 : gapPoints * viabilityMultiplier;
  const score = Math.round(Math.min(Math.max(raw, 0), MAX_SCORE) * 100) / 100;

  return { gapPoints, reviewCredit, ratingCredit, phoneCredit, ghostPenaltyApplied, viabilityMultiplier, score };
}

export function computeScore(signals: DetectedSignal[], business: ScorableBusiness): number {
  return explainScore(signals, business).score;
}
