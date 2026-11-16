import { adminClient } from "@/lib/supabase/admin";
import { BulkUsers } from "@/components/admin/bulk-users";
import { ApiForm } from "@/components/admin/api-form";
import { UserStatusButton } from "@/components/admin/row-actions";

export const metadata = { title: "People" };
export const dynamic = "force-dynamic";

export default async function People() {
  const { data } = await adminClient().from("profiles").select("id, university_id, full_name, role, account_status").order("role").order("university_id").limit(500);
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">People</h1>
      <section className="panel space-y-3 p-5"><h2 className="font-bold">Create accounts</h2><BulkUsers /></section>
      <section className="panel space-y-3 p-5">
        <h2 className="font-bold">Lost phone or new device</h2>
        <p className="text-sm text-ink-soft">Verify the student&apos;s identity in person first. A student account is limited to one active browser or installed-PWA assignment. Resetting devices revokes the old assignment so the student can sign in on a replacement phone or browser. If the same browser&apos;s storage identity changed, clear that site&apos;s data only after this reset. The action is recorded in the audit log.</p>
        <ApiForm endpoint="/api/admin/recovery" submit="Reset passkeys and devices" fields={[
          { name: "universityId", label: "Student university ID" }, { name: "reason", label: "Reason", hint: "For example: lost phone, verified with student card" },
          { name: "revokePasskeys", label: "Revoke passkeys", type: "checkbox", defaultValue: true }, { name: "revokeDevices", label: "Revoke linked devices", type: "checkbox", defaultValue: true },
        ]} successMessage="device-recovery" />
      </section>
      <section>
        <h2 className="mb-2 text-lg font-bold">All accounts ({data?.length ?? 0})</h2>
        <div className="panel overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="border-b border-line text-ink-soft"><tr><th className="p-3">ID</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>{(data ?? []).map((u) => (
            <tr key={u.id} className="border-b border-line last:border-0"><td className="p-3 tabular-nums">{u.university_id}</td><td className="font-semibold">{u.full_name}</td><td>{u.role}</td>
              <td><span className={u.account_status === "active" ? "pill pill-ok" : "pill pill-bad"}>{u.account_status}</span></td><td className="p-3 text-right"><UserStatusButton id={u.id} status={u.account_status} /></td></tr>))}</tbody>
        </table></div>
      </section>
    </div>
  );
}
