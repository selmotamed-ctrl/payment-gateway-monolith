import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { PrismaLike } from "../../engine/db/ports";
import { Vault } from "../../engine/crypto/Vault";
import { env } from "../env";
import { getCommunicationConfiguration } from "../communication/settings";

/**
 * Server-side Google OAuth 2.0 authorization-code flow with PKCE.
 *
 * The frontend gets an authorization URL, navigates the browser to Google, and the provider returns to the public
 * edge callback. Core exchanges the code, verifies the ID token against Google's JWKS and issues a short-lived,
 * single-use login ticket. The normal session is minted only when the frontend exchanges that ticket, so no session
 * JWT ever appears in a URL.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const STATE_TTL_MS = 5 * 60_000;
const TICKET_TTL_MS = 60_000;

const vault = new Vault();

export type GoogleMode = "login" | "register";
export type AuthChannel = "MERCHANT";

export interface GoogleStartInput {
  mode: GoogleMode;
  returnPath: "/login" | "/register";
  ip: string | null;
}

export interface GoogleStartResult {
  authorizationUrl: string;
  state: string;
}

export interface GoogleCallbackResult {
  redirectPath?: string;
  errorPath?: string;
  errorCode?: string;
  userId?: string;
  merchantId?: string | null;
}

export interface GoogleIdentityClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  hostedDomain: string | null;
  name: string | null;
}

export interface GoogleTokenVerifier {
  verify(idToken: string, clientId: string, nonce: string): Promise<GoogleIdentityClaims>;
}

export const defaultGoogleTokenVerifier: GoogleTokenVerifier = {
  verify: async (idToken, clientId, nonce) => {
    const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: clientId,
    });
    if (payload.nonce !== nonce) {
      throw new Error("Google token nonce mismatch");
    }
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) throw new Error("Google token has no e-mail");
    return {
      sub: String(payload.sub),
      email,
      emailVerified: payload.email_verified === true,
      hostedDomain: typeof payload.hd === "string" ? payload.hd : null,
      name: typeof payload.name === "string" ? payload.name : null,
    };
  },
};

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const base64url = (value: Buffer): string => value.toString("base64url");

export const startGoogleOAuth = async (
  db: PrismaLike,
  input: GoogleStartInput,
): Promise<GoogleStartResult> => {
  const config = await getCommunicationConfiguration(db as never);
  if (!config.google.enabled || !config.google.clientId || !config.google.redirectUri) {
    throw new Error("GOOGLE_NOT_CONFIGURED");
  }
  if (input.returnPath !== "/login" && input.returnPath !== "/register") {
    throw new Error("GOOGLE_RETURN_PATH_INVALID");
  }
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(18).toString("base64url");
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  await db.oAuthState.create({
    data: {
      stateHash: sha256(state),
      mode: input.mode,
      returnPath: input.returnPath,
      redirectUri: config.google.redirectUri,
      nonce,
      codeVerifierCiphertext: await vault.encryptSecret(verifier, "google-oauth-verifier"),
      ip: input.ip,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    },
  });
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.google.clientId);
  url.searchParams.set("redirect_uri", config.google.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account");
  if (config.google.hostedDomain) url.searchParams.set("hd", config.google.hostedDomain);
  return { authorizationUrl: url.toString(), state };
};

const exchangeCode = async (input: {
  code: string;
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<{ idToken: string }> => {
  const form = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
    code_verifier: input.verifier,
  });
  const response = await (input.fetchImpl ?? fetch)(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!response.ok) {
    throw new Error(`Google token endpoint returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
  if (!idToken) throw new Error("Google token response has no id_token");
  return { idToken };
};

const ensureGoogleIdentity = async (db: PrismaLike, userId: string, claims: GoogleIdentityClaims): Promise<void> => {
  const existing = await db.userIdentity.findFirst({
    where: { kind: "GOOGLE", providerSubject: claims.sub },
    select: { id: true, userId: true },
  });
  if (!existing) {
    await db.userIdentity.create({
      data: {
        userId,
        kind: "GOOGLE",
        identifierNormalized: claims.email,
        providerSubject: claims.sub,
        verifiedAt: new Date(),
        isPrimary: false,
      },
    });
  }
  const emailIdentity = await db.userIdentity.findFirst({
    where: { userId, kind: "EMAIL", identifierNormalized: claims.email },
    select: { id: true, verifiedAt: true },
  });
  if (emailIdentity && !emailIdentity.verifiedAt) {
    await db.userIdentity.update({ where: { id: emailIdentity.id }, data: { verifiedAt: new Date() } });
  }
};

const provisionGoogleMerchant = async (
  db: PrismaLike,
  claims: GoogleIdentityClaims,
): Promise<{ userId: string; merchantId: string }> =>
  db.$transaction(async (tx: PrismaLike) => {
    const merchant = await tx.merchant.create({
      data: {
        legalName: claims.name?.trim() || claims.email,
        tradeName: claims.name?.trim() || claims.email,
        status: "PENDING",
        kybStatus: "UNVERIFIED",
        riskTier: "STANDARD",
        onboardingChannel: "SELF_SERVICE",
        country: "LY",
        contactEmail: claims.email,
      },
    });
    const user = await tx.user.create({
      data: {
        merchantId: merchant.id,
        email: claims.email,
        phone: null,
        passwordHash: null,
        role: "MERCHANT_ADMIN",
        authoritiesMap: ["merchant:read", "merchant:write", "link:write", "payment:read"],
        isMaker: true,
        isChecker: false,
        mfaRequired: true,
        status: "ACTIVE",
      },
    });
    await tx.userIdentity.create({
      data: {
        userId: user.id,
        kind: "EMAIL",
        identifierNormalized: claims.email,
        verifiedAt: new Date(),
        isPrimary: true,
      },
    });
    await tx.userIdentity.create({
      data: {
        userId: user.id,
        kind: "GOOGLE",
        identifierNormalized: claims.email,
        providerSubject: claims.sub,
        verifiedAt: new Date(),
        isPrimary: false,
      },
    });
    const glAccount = await tx.glAccount.create({
      data: { accountType: "MERCHANT_WALLET", ownerId: merchant.id, currency: env.BASE_CURRENCY },
    });
    await tx.wallet.create({
      data: { merchantId: merchant.id, glAccountId: glAccount.id, currency: env.BASE_CURRENCY, status: "PENDING" },
    });
    await tx.joinRequest.create({
      data: {
        merchantId: merchant.id,
        submittedByUserId: user.id,
        status: "DRAFT",
        onboardingChannel: "SELF_SERVICE",
        slaDueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
        proposedRiskTier: "STANDARD",
        fourEyesRequired: false,
        fourEyesReasons: [],
      },
    });
    return { userId: String(user.id), merchantId: String(merchant.id) };
  });

export const handleGoogleCallback = async (
  db: PrismaLike,
  input: {
    code: string;
    state: string;
    ip: string | null;
    fetchImpl?: typeof fetch;
    verifier?: GoogleTokenVerifier;
  },
): Promise<GoogleCallbackResult> => {
  const config = await getCommunicationConfiguration(db as never);
  if (!config.google.enabled || !config.google.clientId || !config.google.clientSecret) {
    return { errorPath: "/login?error=GOOGLE_NOT_CONFIGURED", errorCode: "GOOGLE_NOT_CONFIGURED" };
  }
  const stateRow = await db.oAuthState.findUnique({ where: { stateHash: sha256(input.state) } });
  if (!stateRow || stateRow.consumedAt || stateRow.expiresAt.getTime() <= Date.now()) {
    return { errorPath: "/login?error=GOOGLE_STATE_INVALID", errorCode: "GOOGLE_STATE_INVALID" };
  }
  const claimed = await db.oAuthState.updateMany({
    where: { id: stateRow.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) {
    return { errorPath: "/login?error=GOOGLE_STATE_INVALID", errorCode: "GOOGLE_STATE_INVALID" };
  }
  let verifier: string;
  try {
    verifier = await vault.decryptSecret(String(stateRow.codeVerifierCiphertext));
  } catch {
    return { errorPath: "/login?error=GOOGLE_STATE_INVALID", errorCode: "GOOGLE_STATE_INVALID" };
  }
  try {
    const { idToken } = await exchangeCode({
      code: input.code,
      verifier,
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      redirectUri: String(stateRow.redirectUri),
      fetchImpl: input.fetchImpl,
    });
    const claims = await (input.verifier ?? defaultGoogleTokenVerifier).verify(
      idToken,
      config.google.clientId,
      String(stateRow.nonce),
    );
    if (!claims.emailVerified) {
      return { errorPath: "/login?error=GOOGLE_EMAIL_NOT_VERIFIED", errorCode: "GOOGLE_EMAIL_NOT_VERIFIED" };
    }
    if (config.google.hostedDomain && claims.hostedDomain !== config.google.hostedDomain) {
      return { errorPath: "/login?error=GOOGLE_DOMAIN_NOT_ALLOWED", errorCode: "GOOGLE_DOMAIN_NOT_ALLOWED" };
    }

    let user: Record<string, any> | null = null;
    const googleIdentity = await db.userIdentity.findFirst({
      where: { kind: "GOOGLE", providerSubject: claims.sub },
      select: { userId: true },
    });
    if (googleIdentity) {
      user = await db.user.findUnique({ where: { id: googleIdentity.userId } });
    }
    if (!user) {
      user = await db.user.findFirst({ where: { email: claims.email } });
      if (user) {
        if (user.merchantId === null || !String(user.role).startsWith("MERCHANT_")) {
          return { errorPath: "/login?error=GOOGLE_STAFF_ACCOUNT", errorCode: "GOOGLE_STAFF_ACCOUNT" };
        }
        await ensureGoogleIdentity(db, String(user.id), claims);
      }
    }
    if (!user) {
      if (stateRow.mode !== "register") {
        return { errorPath: "/login?error=GOOGLE_ACCOUNT_NOT_REGISTERED", errorCode: "GOOGLE_ACCOUNT_NOT_REGISTERED" };
      }
      const created = await provisionGoogleMerchant(db, claims);
      user = await db.user.findUnique({ where: { id: created.userId } });
    }
    if (!user || user.status !== "ACTIVE") {
      return { errorPath: "/login?error=GOOGLE_ACCOUNT_NOT_ACTIVE", errorCode: "GOOGLE_ACCOUNT_NOT_ACTIVE" };
    }
    const ticket = randomBytes(32).toString("base64url");
    await db.oAuthLoginTicket.create({
      data: {
        tokenHash: sha256(ticket),
        userId: String(user.id),
        expiresAt: new Date(Date.now() + TICKET_TTL_MS),
      },
    });
    return {
      redirectPath: `/auth/google/finish?ticket=${encodeURIComponent(ticket)}`,
      userId: String(user.id),
      merchantId: user.merchantId === null ? null : String(user.merchantId),
    };
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith("Google") ? "GOOGLE_TOKEN_INVALID" : "GOOGLE_LOGIN_FAILED";
    return { errorPath: `/login?error=${code}`, errorCode: code };
  }
};

export const exchangeGoogleLoginTicket = async (
  db: PrismaLike,
  input: { ticket: string },
): Promise<Record<string, any>> => {
  const hash = sha256(input.ticket);
  const ticket = await db.oAuthLoginTicket.findUnique({ where: { tokenHash: hash } });
  if (!ticket || ticket.consumedAt || ticket.expiresAt.getTime() <= Date.now()) {
    throw new Error("GOOGLE_TICKET_INVALID");
  }
  const claimed = await db.oAuthLoginTicket.updateMany({
    where: { id: ticket.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) throw new Error("GOOGLE_TICKET_INVALID");
  const user = await db.user.findUnique({ where: { id: ticket.userId } });
  if (
    !user ||
    user.status !== "ACTIVE" ||
    user.merchantId === null ||
    !String(user.role).startsWith("MERCHANT_")
  ) {
    throw new Error("GOOGLE_ACCOUNT_NOT_ACTIVE");
  }
  return user;
};

export const googleOAuthConfigured = async (db: PrismaLike): Promise<boolean> =>
  (await getCommunicationConfiguration(db as never)).google.configured;

/** Exposed for the startup diagnostic; contains no secret. */
export const googleEnvironmentConfigured = (): boolean =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI && env.GOOGLE_AUTH_ENABLED);
