export const DEFAULT_TZ = "Africa/Cairo";

export function formatDateTime(iso: string | Date, tz = DEFAULT_TZ, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }).format(typeof iso === "string" ? new Date(iso) : iso);
}
export const formatTime = (iso: string | Date, tz = DEFAULT_TZ) => formatDateTime(iso, tz, { timeStyle: "short" });

/** Weekday (0 = Sunday) and HH:MM:SS in the university timezone. */
export function localParts(now: Date, tz = DEFAULT_TZ) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(now);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hh = get("hour") === "24" ? "00" : get("hour");
  return { weekday, time: `${hh}:${get("minute")}:${get("second")}` };
}
