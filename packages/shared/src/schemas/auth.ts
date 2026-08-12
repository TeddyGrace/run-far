import { z } from "zod";

export const setPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
