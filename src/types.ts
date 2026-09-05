import { createHash } from "node:crypto";

export type ReservationKind = "flight" | "train" | "bus" | "lodging" | "restaurant";

export interface Reservation {
  kind: ReservationKind;
  provider: string;
  confirmation: string;
  start: string;
  end: string;
  origin: string;
  destination: string;
  location: string;
  timezone: string;
  segment: string;
  cancelled: boolean;
}

export interface IdentifiedReservation extends Reservation {
  reservationKey: string;
  segmentKey: string;
  contentHash: string;
}

export interface EventSpec {
  reservationKey: string;
  segmentKey: string;
  title: string;
  start: string;
  end: string;
  timezone: string;
  allDay: boolean;
  location: string;
  notes: string;
  contentHash: string;
}

export interface EventLink {
  segmentKey: string;
  reservationKey: string;
  eventId: number;
  contentHash: string;
  owned: boolean;
  currentStart: string;
  currentSegment: string;
  currentProvider: string;
}

export type Action = "create" | "update" | "delete" | "noop";

export interface CalendarPlan {
  action: Action;
  spec?: EventSpec;
  eventId?: number;
  linkSegmentKey?: string;
  lookupDate?: string;
  reason: string;
}

export function identify(reservation: Reservation): IdentifiedReservation {
  const folded = (value: string) => value.trim().toLocaleLowerCase("en-US");
  const reservationIdentity = reservation.kind === "lodging"
    ? [reservation.kind, folded(reservation.provider), reservation.start.slice(0, 10), reservation.end.slice(0, 10), folded(reservation.location)]
    : reservation.confirmation
    ? [reservation.kind, folded(reservation.provider), folded(reservation.confirmation)]
    : [
        reservation.kind,
        folded(reservation.provider),
        reservation.start,
        reservation.end,
        folded(reservation.origin),
        folded(reservation.destination),
        folded(reservation.location),
        folded(reservation.segment),
      ];
  const reservationKey = digest(reservationIdentity);
  const segmentIdentity = [reservationKey, reservation.kind];
  if (reservation.segment) segmentIdentity.push(normalizeSegment(reservation.segment));
  else if (reservation.origin || reservation.destination) {
    segmentIdentity.push(folded(reservation.origin), folded(reservation.destination));
  } else segmentIdentity.push("primary");
  return {
    ...reservation,
    reservationKey,
    segmentKey: digest(segmentIdentity),
    contentHash: digest(reservation),
  };
}

export function normalizeSegment(value: string): string {
  const upper = value.trim().toUpperCase();
  const compact = upper.replace(/[^A-Z0-9]/g, "");
  const numbered = upper.match(/(?:^|[^0-9])(\d{1,5}[A-Z]?)$/)?.[1];
  return numbered || compact.toLocaleLowerCase("en-US");
}

export function eventSpec(reservation: IdentifiedReservation, defaultTimezone: string): EventSpec {
  const provider = reservation.provider || titleCase(reservation.kind);
  let title = "";
  if (["flight", "train", "bus"].includes(reservation.kind)) {
    title = `${provider} ${reservation.segment}`.trim();
    const route = [reservation.origin, reservation.destination].filter(Boolean).join(" to ");
    if (route) title += `: ${route}`;
  }
  title ||= provider;
  const spec = {
    reservationKey: reservation.reservationKey,
    segmentKey: reservation.segmentKey,
    title,
    start: reservation.start,
    end: reservation.kind === "restaurant" && reservation.end === reservation.start
      ? addHour(reservation.end)
      : reservation.end,
    timezone: reservation.timezone || defaultTimezone,
    allDay: reservation.kind === "lodging",
    location: reservation.location,
    notes: [
      "hey-travel-sync:v1",
      `reservation=${reservation.reservationKey}`,
      `segment=${reservation.segmentKey}`,
    ].join("\n"),
  };
  return { ...spec, contentHash: digest(spec) };
}

export function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 32);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function addHour(value: string): string {
  if (/(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return new Date(Date.parse(value) + 3_600_000).toISOString();
  }
  const date = new Date(`${value}Z`);
  date.setUTCHours(date.getUTCHours() + 1);
  return date.toISOString().replace(/Z$/, "").replace(/\.000$/, "");
}
