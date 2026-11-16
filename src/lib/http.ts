import "server-only";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: Record<string, unknown>) {
    super(message ?? code);
  }
}

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function readBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, "invalid_request", "Body must be JSON"); }
  return schema.parse(raw);
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Wraps a route handler: maps ApiError/ZodError to JSON and hides internals behind generic 500s. */
export function route<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.code, message: e.message, ...e.extra }, e.status);
      if (e instanceof ZodError) return json({ error: "invalid_request", message: "Request validation failed" }, 400);
      console.error("[api]", req.method, new URL(req.url).pathname, e);
      return json({ error: "server_error", message: "Something went wrong" }, 500);
    }
  };
}

export type IdCtx = { params: Promise<{ id: string }> };
