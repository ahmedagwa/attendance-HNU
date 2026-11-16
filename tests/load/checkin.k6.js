// k6 load test for the check-in pipeline (report §10): 100 simultaneous attempt creations, stressed to 200.
//   k6 run -e BASE_URL=https://staging.example.edu -e QR_PAYLOAD=... -e TOKENS=tokens.json -e INSTALLATION_IDS=installations.json tests/load/checkin.k6.js
// QR_PAYLOAD must be a live payload copied from the projector (valid ~7 s), so start the run immediately.
// TOKENS: JSON array of Supabase access-token cookies ("sb-...-auth-token=...") for staging students.
// INSTALLATION_IDS: JSON array of the matching raw browser-installation UUIDs already linked to those students.
import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";

const tokens = new SharedArray("tokens", () => JSON.parse(open(__ENV.TOKENS)));
const installationIds = new SharedArray("installation_ids", () => JSON.parse(open(__ENV.INSTALLATION_IDS)));

export const options = {
  scenarios: {
    burst_100: { executor: "per-vu-iterations", vus: 100, iterations: 1, maxDuration: "30s", exec: "attempt" },
    stress_200: { executor: "per-vu-iterations", vus: 200, iterations: 1, maxDuration: "30s", startTime: "35s", exec: "attempt" },
  },
  thresholds: { http_req_duration: ["p(95)<2000"], "checks{scenario:burst_100}": ["rate>0.99"] },
};

export function attempt() {
  const index = (__VU - 1) % tokens.length;
  const res = http.post(`${__ENV.BASE_URL}/api/attendance/attempts`, JSON.stringify({
    qrPayload: __ENV.QR_PAYLOAD,
    installationId: installationIds[index],
  }), {
    headers: { "Content-Type": "application/json", Cookie: tokens[index] },
  });
  check(res, { "attempt created (200) or already checked in (409)": (r) => r.status === 200 || r.status === 409 });
}
