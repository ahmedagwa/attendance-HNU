import { describe, expect, it } from "vitest";
import { fromBytea, toBytea } from "@/lib/bytea";
import { csvCell } from "@/lib/csv";
import { localParts } from "@/lib/time";
import { ENTITIES } from "@/lib/admin-entities";

describe("bytea", () => {
  it("round-trips PostgREST hex", () => {
    const u8 = new Uint8Array([0, 1, 127, 128, 255]);
    expect(toBytea(u8)).toBe("\\x00017f80ff");
    expect([...fromBytea(toBytea(u8))]).toEqual([...u8]);
  });
});

describe("CSV export safety", () => {
  it("neutralises spreadsheet formula injection", () => {
    for (const evil of ["=HYPERLINK(\"x\")", "+1+1", "-2+3", "@SUM(A1)"]) expect(csvCell(evil).replace(/^"/, "")).toMatch(/^'/);
  });
  it("quotes commas, quotes and newlines; leaves plain text alone", () => {
    expect(csvCell("Hello, world")).toBe('"Hello, world"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
  });
});

describe("timezone helpers", () => {
  it("renders weekday in Africa/Cairo (UTC+2/+3), not the server timezone", () => {
    // 2026-11-14 23:30 UTC is already Sunday 01:30 in Cairo (UTC+2 in winter)
    expect(localParts(new Date("2026-11-14T23:30:00Z"), "Africa/Cairo").weekday).toBe(0);
    expect(localParts(new Date("2026-11-14T21:30:00Z"), "Africa/Cairo").weekday).toBe(6);
  });
});

describe("admin entity validation", () => {
  it("rejects out-of-range hall configuration", () => {
    expect(ENTITIES.halls.create.safeParse({ name: "A", latitude: 95, longitude: 0 }).success).toBe(false);
    expect(ENTITIES.halls.create.safeParse({ name: "A", latitude: 29.8, longitude: 31.3, allowed_radius_meters: 5 }).success).toBe(false);
    expect(ENTITIES.halls.create.parse({ name: "A", latitude: 29.8, longitude: 31.3 })).toMatchObject({ allowed_radius_meters: 75, max_gps_accuracy_meters: 100 });
  });
  it("requires HH:MM schedule times", () => {
    const base = { subject_id: "00000000-0000-0000-0000-000000000001", group_id: "00000000-0000-0000-0000-000000000002", hall_id: "00000000-0000-0000-0000-000000000003", weekday: 1 };
    expect(ENTITIES.schedules.create.safeParse({ ...base, start_time: "9:00", end_time: "10:30" }).success).toBe(false);
    expect(ENTITIES.schedules.create.safeParse({ ...base, start_time: "09:00", end_time: "10:30" }).success).toBe(true);
  });
});
