import "server-only";
import { z } from "zod";
import { DEMO_ROOM_ID } from "@/shared/room";

const schema = z.object({
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  DEMO_ROOM_ID: z.string().min(1).default(DEMO_ROOM_ID),
  DEMO_ADMIN_PASSCODE: z.string().default(""),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | undefined;

// Validated lazily so `next build` doesn't need runtime secrets.
export function serverEnv(): ServerEnv {
  cached ??= schema.parse(process.env);
  return cached;
}
