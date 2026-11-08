// The model reports times exactly as printed (local wall clock) plus an IANA zone; all offset
// arithmetic happens here so DST and cross-zone legs are computed, never guessed.

const localPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone.length > 0;
  } catch {
    return false;
  }
}

export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export function isLocalDateTime(value: string): boolean {
  const match = localPattern.exec(value);
  return Boolean(match && isDate(value.slice(0, 10)) && Number(match[4]) < 24 && Number(match[5]) < 60);
}

/** Converts a local wall-clock time in `zone` to the instant it names. */
export function toInstant(local: string, zone: string): Date {
  const match = localPattern.exec(local);
  if (!match) throw new Error(`not a local date-time: ${local}`);
  const [, year, month, day, hour, minute] = match.map(Number) as number[];
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  // Two passes settle the offset, including near DST transitions.
  let instant = wall - offsetMs(wall, zone);
  instant = wall - offsetMs(instant, zone);
  return new Date(instant);
}

/** Wall-clock date (YYYY-MM-DD) and time (HH:MM) of an instant in `zone`. */
export function wallClock(instant: Date, zone: string): { date: string; time: string } {
  const parts = partsIn(instant, zone);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Human label such as "Thu Nov 12, 8:45 PM CST". */
export function describe(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(instant).replace(" at ", ", ");
}

/** Short time label such as "8:45 PM CST". */
export function shortTime(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(instant);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function offsetMs(instant: number, zone: string): number {
  const parts = partsIn(new Date(instant), zone);
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

function partsIn(instant: Date, zone: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}
