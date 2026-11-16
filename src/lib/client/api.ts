export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string, public data: Record<string, unknown> = {}) { super(message); }
}

/** JSON fetch helper that surfaces the server's {error, message} shape as a typed exception. */
export async function api<T = Record<string, unknown>>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? (init?.body ? "POST" : "GET"),
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined, cache: "no-store",
    });
  } catch { throw new ApiFailure(0, "network", "You appear to be offline. Check your connection and try again."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiFailure(res.status, data.error ?? "error", data.message ?? "Something went wrong. Try again.", data);
  return data as T;
}
