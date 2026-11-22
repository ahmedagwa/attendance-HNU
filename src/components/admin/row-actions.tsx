"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiFailure } from "@/lib/client/api";

export function UserStatusButton({ id, status, universityId, fullName, role }: {
  id: string;
  status: "active" | "suspended";
  universityId: string;
  fullName: string;
  role: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="flex items-center justify-end gap-3 whitespace-nowrap">
      <button className="font-semibold text-teal underline disabled:opacity-50" disabled={busy || deleting} onClick={async () => {
        setBusy(true);
        try { await api("/api/admin/users", { method: "PATCH", body: { id, accountStatus: status === "active" ? "suspended" : "active" } }); router.refresh(); } catch (e) { alert(e instanceof ApiFailure ? e.message : "Failed"); }
        setBusy(false);
      }}>{status === "active" ? "Suspend" : "Reactivate"}</button>
      <button className="font-semibold text-bad underline disabled:opacity-50" disabled={busy || deleting} onClick={async () => {
        const confirmed = window.confirm(
          `Permanently delete this account?\n\n${fullName} (${universityId})\nRole: ${role}\n\nThis cannot be undone. Student enrollments, attendance records, passkeys, and linked device assignments may also be deleted. Session and verification history will be retained, but the deleted account will no longer be shown as their creator. Student attendance and enrollment records linked to this account may be permanently deleted.`
        );
        if (!confirmed) return;
        setDeleting(true);
        try {
          await api("/api/admin/users", { method: "DELETE", body: { id } });
          router.refresh();
        } catch (e) {
          alert(e instanceof ApiFailure ? e.message : "Could not delete account.");
        }
        setDeleting(false);
      }}>{deleting ? "Deleting…" : "Delete"}</button>
    </div>
  );
}

export function FlagButtons({ id, canApprove }: { id: string; canApprove: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const act = async (decision: string) => { setBusy(true); try { await api(`/api/flags/${id}/resolve`, { body: { decision } }); router.refresh(); } catch (e) { alert(e instanceof ApiFailure ? e.message : "Failed"); } setBusy(false); };
  return (
    <div className="flex gap-1.5">
      {canApprove && <button disabled={busy} className="btn btn-primary min-h-9 text-sm" onClick={() => act("approve")}>Approve</button>}
      <button disabled={busy} className="btn btn-quiet min-h-9 text-sm" onClick={() => act("dismiss")}>Dismiss</button>
      {canApprove && <button disabled={busy} className="btn btn-quiet min-h-9 text-sm text-bad" onClick={() => act("reject")}>Reject</button>}
    </div>
  );
}
