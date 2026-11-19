"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiFailure } from "@/lib/client/api";

export type Field = {
  name: string;
  label: string;
  type?: "text" | "number" | "select" | "time" | "date" | "checkbox" | "textarea" | "password";
  options?: { value: string; label: string }[];
  defaultValue?: string | number | boolean;
  required?: boolean;
  step?: string;
  hint?: string;
  optional?: boolean;
  /** Parse a select/textarea value before sending it to the API. */
  valueFormat?: "number" | "string-list";
};

type SuccessMessage = "enrollment" | "device-recovery" | "staff-assignment" | "staff-removal";

function getSuccessMessage(kind: SuccessMessage | undefined, result: Record<string, unknown>) {
  if (kind === "enrollment") {
    const unknown = Array.isArray(result.unknown)
      ? result.unknown.map((value) => String(value))
      : [];
    const enrolled = Number(result.enrolled ?? 0);
    return `Enrolled ${enrolled}.${unknown.length ? ` Not found: ${unknown.join(", ")}` : ""}`;
  }

  if (kind === "device-recovery") {
    const passkeys = Number(result.passkeysRevoked ?? 0);
    const devices = Number(result.devicesRevoked ?? 0);
    return `Revoked ${passkeys} passkey(s) and ${devices} device(s).`;
  }

  if (kind === "staff-assignment") return "Teaching staff member assigned to the subject.";
  if (kind === "staff-removal") return "Teaching staff assignment removed.";

  return "Saved.";
}

/** Small generic form that posts JSON to an admin endpoint and reports the outcome.
 *  All props are serializable because this component is rendered by Server Components.
 */
export function ApiForm({
  endpoint,
  fields,
  submit,
  method = "POST",
  successMessage,
}: {
  endpoint: string;
  fields: Field[];
  submit: string;
  method?: string;
  successMessage?: SuccessMessage;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);

    const form = e.currentTarget;
    const formData = new FormData(form);
    const values: Record<string, unknown> = {};

    for (const field of fields) {
      const raw = formData.get(field.name);

      if (field.type === "checkbox") {
        values[field.name] = raw === "on";
      } else if (field.valueFormat === "string-list") {
        values[field.name] = String(raw ?? "")
          .split(/[\s,;]+/)
          .filter(Boolean);
      } else if (field.valueFormat === "number" || field.type === "number") {
        const value = raw == null ? "" : String(raw).trim();
        values[field.name] = value === ""
          ? (field.optional ? null : undefined)
          : Number(value);
      } else if (raw === "" && field.optional) {
        values[field.name] = null;
      } else {
        values[field.name] = raw;
      }
    }

    try {
      const result = await api<Record<string, unknown>>(endpoint, {
        method,
        body: values,
      });
      setMsg({ ok: true, text: getSuccessMessage(successMessage, result) });
      form.reset();
      router.refresh();
    } catch (err) {
      setMsg({
        ok: false,
        text: err instanceof ApiFailure ? err.message : "Could not save.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
      {fields.map((field) => (
        <label
          key={field.name}
          className={`block ${field.type === "textarea" ? "sm:col-span-2" : ""} ${field.type === "checkbox" ? "flex items-center gap-2" : ""}`}
        >
          <span className={field.type === "checkbox" ? "order-2 text-sm font-semibold" : "mb-1 block text-sm font-semibold"}>
            {field.label}
          </span>
          {field.type === "select" ? (
            <select
              name={field.name}
              className="input"
              required={field.required !== false && !field.optional}
              defaultValue={String(field.defaultValue ?? "")}
            >
              {field.optional && <option value="">None</option>}
              {field.options?.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : field.type === "textarea" ? (
            <textarea
              name={field.name}
              className="input min-h-28 font-mono text-sm"
              required={field.required !== false}
              defaultValue={String(field.defaultValue ?? "")}
            />
          ) : field.type === "checkbox" ? (
            <input
              name={field.name}
              type="checkbox"
              defaultChecked={Boolean(field.defaultValue)}
              className="size-5 accent-teal"
            />
          ) : (
            <input
              name={field.name}
              type={field.type ?? "text"}
              step={field.step}
              className="input"
              required={field.required !== false && !field.optional}
              defaultValue={field.defaultValue as string | number | undefined}
            />
          )}
          {field.hint && <span className="mt-1 block text-xs text-ink-soft">{field.hint}</span>}
        </label>
      ))}
      <div className="sm:col-span-2">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Saving…" : submit}
        </button>
        {msg && (
          <p
            role={msg.ok ? "status" : "alert"}
            className={`mt-2 rounded-lg p-2.5 text-sm ${msg.ok ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad"}`}
          >
            {msg.text}
          </p>
        )}
      </div>
    </form>
  );
}
