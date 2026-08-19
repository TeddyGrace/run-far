import { z } from "zod";

export const setPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  currentPassword: z.string().min(1).max(200).optional(),
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
});
export type SignupInput = z.infer<typeof signupSchema>;

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

export const resendVerificationSchema = z.object({
  email: z.string().email(),
});
export type ResendVerificationInput = z.infer<typeof resendVerificationSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(10).max(200),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
