import { describe, expect, it } from "vitest";
import { evaluateGeofence, haversineMeters, type Hall } from "@/lib/geo";

const hall: Hall = { latitude: 29.8500, longitude: 31.3300, allowed_radius_meters: 75, max_gps_accuracy_meters: 100 };
// ~111.2 m per 0.001° latitude
const at = (metersNorth: number, accuracy: number) => ({ latitude: hall.latitude + metersNorth / 111_195, longitude: hall.longitude, accuracy });

describe("haversine", () => {
  it("is zero for identical points and ~111.2 km per degree of latitude", () => {
    expect(haversineMeters(10, 10, 10, 10)).toBe(0);
    expect(haversineMeters(0, 0, 1, 0)).toBeGreaterThan(111_000);
    expect(haversineMeters(0, 0, 1, 0)).toBeLessThan(111_400);
  });
  it("is symmetric", () => {
    expect(haversineMeters(29.85, 31.33, 30.04, 31.23)).toBeCloseTo(haversineMeters(30.04, 31.23, 29.85, 31.33), 6);
  });
});

describe("geofence decisions (report §6.4 table)", () => {
  it("poor accuracy -> retry/review, never silently accepted (even if the point is inside)", () => {
    expect(evaluateGeofence(at(0, 150), hall).result).toBe("poor_accuracy");
    expect(evaluateGeofence(at(500, 150), hall).result).toBe("poor_accuracy");
  });
  it("good accuracy and inside the radius -> ok", () => {
    expect(evaluateGeofence(at(20, 15), hall).result).toBe("ok");
    expect(evaluateGeofence(at(0, 100), hall).result).toBe("ok"); // accuracy exactly at the limit
  });
  it("outside the radius but the accuracy circle overlaps the boundary -> uncertain, not proof", () => {
    expect(evaluateGeofence(at(100, 40), hall).result).toBe("uncertain");
  });
  it("even the nearest plausible point outside -> outside", () => {
    expect(evaluateGeofence(at(300, 20), hall).result).toBe("outside");
  });
  it("rejects invalid coordinates", () => {
    for (const bad of [{ latitude: NaN, longitude: 0, accuracy: 5 }, { latitude: 91, longitude: 0, accuracy: 5 }, { latitude: 0, longitude: 181, accuracy: 5 }, { latitude: 0, longitude: 0, accuracy: -1 }, { latitude: 0, longitude: 0, accuracy: Infinity }])
      expect(evaluateGeofence(bad, hall).result).toBe("invalid");
  });
  it("respects per-hall configuration", () => {
    const tight: Hall = { ...hall, allowed_radius_meters: 25, max_gps_accuracy_meters: 20 };
    expect(evaluateGeofence(at(30, 8), tight).result).toBe("uncertain");
    expect(evaluateGeofence(at(0, 30), tight).result).toBe("poor_accuracy");
  });
});
