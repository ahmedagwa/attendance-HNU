/** Geofencing (report §6.4): Haversine distance + GPS-accuracy handling. A risk signal, not attestation. */
export type Hall = { latitude: number; longitude: number; allowed_radius_meters: number; max_gps_accuracy_meters: number };
export type Fix = { latitude: number; longitude: number; accuracy: number };
export type GeoResult = "ok" | "uncertain" | "outside" | "poor_accuracy" | "invalid";
export type GeoDecision = { result: GeoResult; distanceMeters: number | null };

const R = 6_371_008.8; // mean Earth radius (m)
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function evaluateGeofence(fix: Fix, hall: Hall): GeoDecision {
  const { latitude, longitude, accuracy } = fix;
  const valid = [latitude, longitude, accuracy].every(Number.isFinite) &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && accuracy >= 0;
  if (!valid) return { result: "invalid", distanceMeters: null };

  const distance = haversineMeters(latitude, longitude, hall.latitude, hall.longitude);
  // Never silently accept a fix that is too coarse to mean anything.
  if (accuracy > hall.max_gps_accuracy_meters) return { result: "poor_accuracy", distanceMeters: distance };
  if (distance <= hall.allowed_radius_meters) return { result: "ok", distanceMeters: distance };
  // Outside the radius, but the accuracy circle overlaps the boundary: uncertain, NOT proof of presence.
  if (distance - accuracy <= hall.allowed_radius_meters) return { result: "uncertain", distanceMeters: distance };
  return { result: "outside", distanceMeters: distance };
}
