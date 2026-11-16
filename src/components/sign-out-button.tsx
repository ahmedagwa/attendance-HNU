"use client";
import { useRouter } from "next/navigation";
import { browserClient } from "@/lib/supabase/browser";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button className="btn btn-quiet" onClick={async () => { await browserClient().auth.signOut(); router.replace("/login"); router.refresh(); }}>
      Sign out
    </button>
  );
}
