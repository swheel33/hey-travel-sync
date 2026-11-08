import { describe as group, expect, test } from "bun:test";
import type { ExtractedReservation } from "../src/extract.ts";
import { normalize, reservationKey } from "../src/reservation.ts";
import { toInstant, wallClock } from "../src/time.ts";

const flight = (overrides: Partial<ExtractedReservation> = {}): ExtractedReservation => ({
  kind: "flight", status: "confirmed", provider: "Delta Air Lines", confirmation: "HQD6JV", number: "DL2513",
  origin: "LGA", destination: "ORD", location: "", start: "2026-11-12T18:55", start_timezone: "America/New_York",
  end: "2026-11-12T20:45", end_timezone: "America/Chicago", ...overrides,
});

group("time", () => {
  test("local wall clock converts to the right instant across DST", () => {
    expect(toInstant("2026-11-12T18:55", "America/New_York").toISOString()).toBe("2026-11-12T23:55:00.000Z");
    expect(toInstant("2026-07-01T09:00", "America/New_York").toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(toInstant("2026-11-01T01:30", "America/Chicago").getTime()).toBeGreaterThan(0);
    expect(toInstant("2026-12-18T06:00", "Asia/Singapore").toISOString()).toBe("2026-12-17T22:00:00.000Z");
  });

  test("wallClock is the inverse of toInstant", () => {
    const instant = toInstant("2027-01-07T12:10", "Asia/Singapore");
    expect(wallClock(instant, "Asia/Singapore")).toEqual({ date: "2027-01-07", time: "12:10" });
    expect(wallClock(instant, "America/New_York")).toEqual({ date: "2027-01-06", time: "23:10" });
  });
});

group("normalize", () => {
  test("cross-zone flight sits in departure zone with true duration and local arrival in title", () => {
    const result = normalize(flight());
    if (typeof result === "string") throw new Error(result);
    expect(result.event).toMatchObject({
      title: "DL2513 LGA → ORD (arr 8:45 PM CST)", timeZone: "America/New_York",
      startDate: "2026-11-12", startTime: "18:55", endDate: "2026-11-12", endTime: "21:45",
    });
    expect(result.event!.notes).toContain("Arrives Thu, Nov 12, 8:45 PM CST · ORD");
  });

  test("overnight long-haul lands on the right day", () => {
    const result = normalize(flight({
      provider: "Singapore Airlines", number: "SQ23", origin: "JFK", destination: "SIN",
      start: "2026-12-16T22:05", end: "2026-12-18T06:00", end_timezone: "Asia/Singapore",
    }));
    if (typeof result === "string") throw new Error(result);
    expect(result.event).toMatchObject({ startDate: "2026-12-16", startTime: "22:05", endDate: "2026-12-17", endTime: "17:00" });
  });

  test("same-zone leg has no arrival suffix", () => {
    const result = normalize(flight({ end_timezone: "America/New_York", end: "2026-11-12T20:00", destination: "BOS" }));
    if (typeof result === "string") throw new Error(result);
    expect(result.event!.title).toBe("DL2513 LGA → BOS");
  });

  test("reminders without times are skipped, not errors", () => {
    expect(normalize(flight({ start: "", end: "" }))).toBeString();
    expect(normalize(flight({ end: "" }))).toBe("transport leg without an arrival time");
  });

  test("arrival before departure is rejected", () => {
    expect(normalize(flight({ end: "2026-11-12T17:00" }))).toContain("not after departure");
  });

  test("restaurant without end gets two hours", () => {
    const result = normalize({
      ...flight(), kind: "restaurant", provider: "Bar Cima", confirmation: "", number: "", origin: "", destination: "",
      location: "30 W 39th St", start: "2026-10-15T19:00", end: "", end_timezone: "",
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.event).toMatchObject({ title: "Bar Cima", startTime: "19:00", endTime: "21:00" });
  });

  test("lodging is all-day check-in to check-out", () => {
    const result = normalize({
      ...flight(), kind: "lodging", provider: "Shangri-La Singapore", confirmation: "9105756819718", number: "",
      origin: "", destination: "", start: "2026-12-18", end: "2026-12-21T12:00", start_timezone: "Asia/Singapore",
    });
    if (typeof result === "string") throw new Error(result);
    expect(result.event).toMatchObject({ allDay: true, startDate: "2026-12-18", endDate: "2026-12-21" });
  });

  test("stay without a check-out is skipped", () => {
    expect(normalize({ ...flight(), kind: "lodging", number: "", start: "2026-12-18", end: "" })).toBe("stay without a check-out date");
  });

  test("cancellation needs a confirmation", () => {
    expect(normalize(flight({ status: "cancelled", confirmation: "" }))).toBeString();
    expect(normalize(flight({ status: "cancelled", start: "" }))).toMatchObject({ cancelled: true });
  });
});

group("reservationKey", () => {
  test("is stable across formatting differences", () => {
    expect(reservationKey(flight({ number: "DL 2513", confirmation: "hqd6jv" }))).toBe(reservationKey(flight()));
    expect(reservationKey(flight({ number: "SQ023" }))).toBe(reservationKey(flight({ number: "SQ 23" })));
    expect(reservationKey(flight({ number: "B6415" }))).toEndWith("|B6415");
    expect(reservationKey(flight({ number: "Amtrak 105" }))).toBe(reservationKey(flight({ number: "AMTRAK105" })));
  });

  test("lodging keys on confirmation regardless of address wording", () => {
    const base = { ...flight(), kind: "lodging" as const, number: "", provider: "Hilton", confirmation: "3528930502" };
    expect(reservationKey({ ...base, start: "2026-09-11" })).toBe("lodging|3528930502");
  });
});
