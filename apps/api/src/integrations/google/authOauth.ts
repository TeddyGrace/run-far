import { OAuth2Client, type Credentials } from "google-auth-library";
import { env } from "../../env.js";

// Sign-in asks for Calendar up front so connecting the calendar isn't a second
// consent screen after login.
export const LOGIN_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar",
];

function newAuthOAuthClient(): OAuth2Client {
  return new OAuth2Client(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_AUTH_REDIRECT_URI,
  );
}

/**
 * `forceConsent` re-prompts for consent, which is the only reliable way to get a
 * refresh token back once the user has already granted access.
 */
export function buildGoogleLoginAuthorizeUrl(state: string, forceConsent = false): string {
  const client = newAuthOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: forceConsent ? "consent" : "select_account",
    scope: LOGIN_SCOPES,
    include_granted_scopes: true,
    state,
  });
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
}

export interface GoogleLoginResult {
  identity: GoogleIdentity;
  tokens: Credentials;
}

/** Exchanges the auth code and verifies the ID token to get a stable Google identity. */
export async function exchangeGoogleLoginCode(code: string): Promise<GoogleLoginResult> {
  const client = newAuthOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw new Error("Google login did not return an id_token");
  }

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new Error("Google ID token missing sub or email");
  }
  if (payload.email_verified === false) {
    throw new Error("Google email is not verified");
  }

  return {
    identity: { sub: payload.sub, email: payload.email, name: payload.name },
    tokens,
  };
}
