import { z } from "zod";
import { guid } from "./ids";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();

/** Create/update schemas for institutional data managed by administrators. */
export const ENTITIES = {
  groups: {
    table: "student_groups",
    create: z.object({ group_code: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(80), academic_year: z.string().trim().min(4).max(20) }),
  },
  halls: {
    table: "halls",
    create: z.object({
      name: z.string().trim().min(1).max(80), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
      allowed_radius_meters: z.number().int().min(10).max(500).default(75), max_gps_accuracy_meters: z.number().int().min(10).max(500).default(100), is_active: z.boolean().default(true),
    }),
  },
  subjects: {
    table: "subjects",
    create: z.object({
      code: z.string().trim().min(2).max(20), name: z.string().trim().min(2).max(120), lecturer_id: guid.nullable().default(null),
      attendance_required_percent: z.number().int().min(0).max(100).default(75), is_active: z.boolean().default(true),
    }),
  },
  schedules: {
    table: "class_schedules",
    create: z.object({
      subject_id: guid, group_id: guid, hall_id: guid, weekday: z.number().int().min(0).max(6),
      start_time: time, end_time: time, valid_from: date, valid_to: date,
    }),
  },
} as const;

export type EntityName = keyof typeof ENTITIES;
export const isEntity = (v: string): v is EntityName => v in ENTITIES;

export const enrollSchema = z.object({
  subjectId: guid, groupId: guid, universityIds: z.array(z.string().trim().min(1).max(40)).min(1).max(300),
});
export const unenrollSchema = z.object({ subjectId: guid, studentId: guid });
