export const metadata = { title: "Offline" };
export default function Offline() {
  return (
    <main className="mx-auto max-w-md p-8 pt-24 text-center">
      <h1 className="text-2xl font-bold">You&apos;re offline</h1>
      <p className="mt-3 text-ink-soft">Checking in needs a live connection so the code and your location can be verified. Reconnect and try again.</p>
    </main>
  );
}
