import { redirect } from "next/navigation";
import { getActor, homeFor } from "@/lib/auth";
import { hasActiveDeviceBinding } from "@/lib/device-installation";
import { LoginForm } from "@/components/login-form";

export const metadata = { title: "Sign in" };

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string; device?: string }> }) {
  const { next, device } = await searchParams;
  const actor = await getActor();
  let deviceNotice: string | undefined;
  if (actor) {
    if (actor.role !== "student") redirect(homeFor(actor.role));
    if (await hasActiveDeviceBinding(actor.id)) redirect(homeFor(actor.role));
    deviceNotice = "This student session is not linked to an approved browser or installed app. Sign in below from the browser/PWA assigned to this student. If you changed phones, browsers or cleared site data, ask an administrator to verify and reset the old device first.";
  } else if (device === "unlinked") {
    deviceNotice = "Your current sign-in session is missing its verified device assignment. Sign in using the browser or installed app previously approved for this student. A replacement phone, different browser, or cleared site data may require an administrator to reset and approve the device.";
  }
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8">
        <div aria-hidden className="mb-5 grid size-14 place-items-center rounded-2xl bg-teal">
          <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="#fff" strokeWidth="2"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" /><path d="M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" /></svg>
        </div>
        <h1 className="text-3xl font-bold">Sign in</h1>
        <p className="mt-2 text-ink-soft">Use the account your university created for you.</p>
      </div>
      <div className="panel p-5"><LoginForm next={next} notice={deviceNotice} /></div>
      <p className="mt-6 text-sm text-ink-soft">Forgot your password or lost your phone? Ask your administrator to reset your account.</p>
    </main>
  );
}
