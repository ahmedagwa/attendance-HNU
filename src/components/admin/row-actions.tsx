"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiFailure } from "@/lib/client/api";

export function UserStatusButton({ id, status }: { id: string; status: "active" | "suspended" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button className="font-semibold text-teal underline disabled:opacity-50" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await api("/api/admin/users", { method: "PATCH", body: { id, accountStatus: status === "active" ? "suspended" : "active" } }); router.refresh(); } catch (e) { alert(e instanceof ApiFailure ? e.message : "Failed"); }
      setBusy(false);
    }}>{status === "active" ? "Suspend" : "Reactivate"}</button>
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
