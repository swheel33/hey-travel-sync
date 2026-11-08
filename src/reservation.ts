import { createHash } from "node:crypto";
import type { ExtractedReservation } from "./extract.ts";
import type { EventInput } from "./hey.ts";
import { describe, isDate, isLocalDateTime, isZone, arrivalLabel, toInstant, wallClock } from "./time.ts";

export interface Reservation {
  key: string;
  kind: ExtractedReservation["kind"];
  cancelled: boolean;
  provider: string;
  confirmation: string;
  label: string;
  event?: EventInput;
}

const transport = new Set(["flight", "train", "bus"]);
const footer = "Added by hey-travel-sync";

/** Validates one model item and renders its calendar event; returns a reason string when it can't be used. */
export function normalize(item: ExtractedReservation): Reservation | string {
  const value = Object.fromEntries(Object.entries(item).map(([key, field]) => [key, field.trim()])) as ExtractedReservation;
  if (!value.provider) return "no provider";
  const key = reservationKey(value);
  const label = [value.provider, value.number, value.confirmation].filter(Boolean).join(" ");
  const base = { key, kind: value.kind, provider: value.provider, confirmation: value.confirmation, label };
  if (value.status === "cancelled") {
    return value.confirmation ? { ...base, cancelled: true } : "cancellation without a confirmation";
  }
  const event = value.kind === "lodging" ? lodgingEvent(value) : timedEvent(value);
  return typeof event === "string" ? event : { ...base, cancelled: false, event };
}

export function reservationKey(value: Pick<ExtractedReservation, "kind" | "provider" | "confirmation" | "number" | "origin" | "destination" | "start">): string {
  const confirmation = compact(value.confirmation);
  const day = value.start.slice(0, 10);
  if (transport.has(value.kind)) {
    const leg = legNumber(value.number) || `${compact(value.origin)}>${compact(value.destination)}`;
    return [value.kind, confirmation || `${compact(value.provider)}@${day}`, leg].join("|");
  }
  return [value.kind, confirmation || `${compact(value.provider)}@${day}`].join("|");
}

/** Keys of a whole booking share this prefix, so a booking-level cancellation can find every leg. */
export function bookingPrefix(kind: string, confirmation: string): string {
  return `${kind}|${compact(confirmation)}`;
}

export function eventHash(event: EventInput): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex").slice(0, 16);
}

function timedEvent(value: ExtractedReservation): EventInput | string {
  const startZone = value.start_timezone;
  const endZone = value.end_timezone || startZone;
  if (!isLocalDateTime(value.start)) return `start "${value.start}" is not a local date-time`;
  if (!isZone(startZone)) return `unknown timezone "${startZone}"`;
  if (!isZone(endZone)) return `unknown timezone "${endZone}"`;
  const start = toInstant(value.start, startZone);
  let end: Date;
  if (value.end) {
    if (!isLocalDateTime(value.end)) return `end "${value.end}" is not a local date-time`;
    end = toInstant(value.end, endZone);
  } else if (value.kind === "restaurant") {
    end = new Date(start.getTime() + 2 * 3_600_000);
  } else {
    return "transport leg without an arrival time";
  }
  if (end <= start) return `arrival ${value.end} ${endZone} is not after departure ${value.start} ${startZone}`;

  // HEY events carry one zone, so the event sits in the departure zone at the correct instants
  // and the arrival's own local time is written into the title and notes.
  const startWall = wallClock(start, startZone);
  const endWall = wallClock(end, startZone);
  const arrivalWall = wallClock(end, endZone);
  const crossesZones = arrivalWall.date !== endWall.date || arrivalWall.time !== endWall.time;
  let title = value.provider;
  const notes: string[] = [];
  if (transport.has(value.kind)) {
    const route = [value.origin, value.destination].filter(Boolean).join(" → ");
    const service = value.kind === "flight" ? value.number || value.provider : [value.provider, value.number].filter(Boolean).join(" ");
    title = [service, route].filter(Boolean).join(" ");
    if (crossesZones) title += ` (arr ${arrivalLabel(end, endZone, value.start.slice(0, 10))})`;
    notes.push(`Departs ${describe(start, startZone)}${value.origin ? ` · ${value.origin}` : ""}`);
    notes.push(`Arrives ${describe(end, endZone)}${value.destination ? ` · ${value.destination}` : ""}`);
    if (value.number) notes.push(value.provider);
  }
  if (value.confirmation) notes.push(`Confirmation ${value.confirmation}`);
  notes.push(footer);
  return {
    title, allDay: false,
    startDate: startWall.date, startTime: startWall.time, endDate: endWall.date, endTime: endWall.time, timeZone: startZone,
    location: value.location || (transport.has(value.kind) ? value.origin : ""),
    notes: notes.join("\n"),
  };
}

function lodgingEvent(value: ExtractedReservation): EventInput | string {
  const checkIn = value.start.slice(0, 10);
  const checkOut = value.end.slice(0, 10);
  if (!isDate(checkIn)) return `check-in "${value.start}" is not a date`;
  if (!checkOut) return "stay without a check-out date";
  if (!isDate(checkOut)) return `check-out "${value.end}" is not a date`;
  if (checkOut < checkIn) return "check-out is before check-in";
  const notes = [`Check-in ${checkIn} · Check-out ${checkOut}`];
  if (value.confirmation) notes.push(`Confirmation ${value.confirmation}`);
  notes.push(footer);
  return {
    title: value.provider, allDay: true, startDate: checkIn, endDate: checkOut,
    location: value.location, notes: notes.join("\n"),
  };
}

/** SQ023, SQ 23, and sq23 are one flight: carrier code plus the number without leading zeros. */
function legNumber(value: string): string {
  const match = /^([A-Z0-9]{2}?[A-Z]*?)0*(\d+[A-Z]?)$/.exec(compact(value));
  return match ? `${match[1]}${match[2]}` : compact(value);
}

function compact(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
