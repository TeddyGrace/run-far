import { z } from "zod";

/** One rule everywhere a password is chosen: signup, reset, and set-password in settings. */
export const MIN_PASSWORD_LENGTH = 10;

export const setPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
  currentPassword: z.string().min(1).max(200).optional(),
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;

export const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
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
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
