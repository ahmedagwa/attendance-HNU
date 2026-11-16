import { z } from "zod";
export const guid = z.guid();
export const isUuid = (v: string) => z.guid().safeParse(v).success;
