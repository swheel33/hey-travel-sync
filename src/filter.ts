import type { ThreadRef } from "./hey.ts";

// Cheap local triage on subject, preview, and sender so routine mail never reaches the model.
const travelCategory = /\b(?:flight|airline|airport|boarding|gate|trip|travel|hotel|lodging|stay|room|restaurant|dining|dinner|lunch|brunch|table|train|rail|railway|station|bus|coach|journey)\b/i;
const reservationArtifact = /\b(?:booking|booked|reservation|reserved|itinerary|e[ -]?ticket|ticket|boarding pass|check-in|check in (?:for|now|online|opens|is open)|voucher|record locator|pnr|billet|billete|reserva|reservierung|buchung)\b/i;
const transactionSignal = /\b(?:confirm(?:ed|ation)?|receipt)\b/i;
const strongReservationPhrase = /\b(?:booking confirmation|reservation confirmation|trip confirmation|flight confirmation|e[ -]?ticket receipt|boarding pass|upcoming stay|table reservation|journey ticket|you(?:'|’)re booked)\b/i;
const disruptionSignal = /\b(?:cancel(?:led|ed|lation)?|schedule chang(?:e|ed)|gate chang(?:e|ed)|platform chang(?:e|ed)|delayed|rebook(?:ed|ing)?)\b/i;
const marketingSignal = /\b(?:sale|offer|newsletter|inspiration|deal|save \d+%|\d+% off|off your next|bonus (?:miles|points)|earn \d+|limited time)\b/i;
const knownProvider = /\b(?:delta|jetblue|united|southwest|american airlines|alaska airlines|air canada|british airways|lufthansa|klm|air france|emirates|qatar|singapore airlines|singaporeair|scoot|cathay|ana|jal|ryanair|easyjet|hilton|marriott|hyatt|ihg|shangri-la|airbnb|booking\.com|expedia|hotels\.com|agoda|opentable|resy|tock|sevenrooms|amtrak|trainline|flixbus|greyhound|megabus)\b/i;
const months = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/i;

export function travelScore(ref: ThreadRef): { candidate: boolean; reasons: string[] } {
  const text = `${ref.subject}\n${ref.summary}`.normalize("NFKC");
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => { score += points; reasons.push(`${reason}:${points > 0 ? "+" : ""}${points}`); };
  const category = travelCategory.test(text);
  const artifact = reservationArtifact.test(text);
  if (category) add(2, "category");
  if (artifact) add(2, "artifact");
  if (transactionSignal.test(text)) add(1, "transaction");
  if (strongReservationPhrase.test(text)) add(2, "strong-phrase");
  if (category || artifact) {
    if (disruptionSignal.test(text)) add(2, "travel-change");
    const structure = Math.min(2, [/\b[A-Z]{2}\s?\d{1,4}\b/, /\b[A-Z]{3}\s*(?:→|->|–|-|to)\s*[A-Z]{3}\b/, months]
      .filter((pattern) => pattern.test(text)).length);
    if (structure) add(structure, "structure");
    if (ref.hasAttachments) add(1, "attachment");
  }
  if (knownProvider.test(ref.sender)) add(2, "provider");
  if (marketingSignal.test(text)) add(-3, "marketing");
  return { candidate: score >= 2, reasons };
}
