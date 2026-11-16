export type RosterStatus = "present" | "late" | "review" | "rejected" | "absent";
export type RosterRow = { studentId: string; universityId: string; fullName: string; groupCode: string; status: RosterStatus; source: "qr" | "manual" | null; checkedInAt: string | null; manualReason: string | null };
export type Flag = { id: string; student_id: string; flag_type: string; severity: "low" | "medium" | "high"; details: Record<string, unknown>; created_at: string; student: { full_name: string; university_id: string } };
export type SpotCheck = { id: string; code: string; expiresAt: string; active: boolean; responded: number; correct: number; nonResponders: { studentId: string; fullName: string; universityId: string }[] };
export type LiveData = {
  session: { id: string; status: "active" | "paused" | "closed"; startedAt: string; subject: { code: string; name: string } };
  summary: { enrolled: number; present: number; late: number; manual: number; review: number; absent: number; open_flags: number };
  roster: RosterRow[]; recent: RosterRow[]; flags: Flag[]; spotCheck: SpotCheck | null; serverTimeMs: number;
};
export const FLAG_LABELS: Record<string, string> = {
  geo_uncertain: "Location couldn't be confirmed", outside_geofence: "Checked in from outside the hall", shared_installation: "Device already used by another account",
  duplicate_installation: "Device already checked in another account", revoked_installation: "Used a revoked device", new_installation: "New device for this student",
  passkey_counter_regression: "Passkey counter went backwards (possible clone)",
  unapproved_new_installation: "New browser/app installation needs administrator approval",
  installation_identity_changed: "Saved browser installation identity changed",
};
