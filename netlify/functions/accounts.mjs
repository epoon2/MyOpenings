/*
  ACCOUNTS

  A person signs up with an email and a password and gets a calendar
  of their own. This module holds the mechanics and nothing about
  calendars themselves:

    users          one record per account, password hashed with scrypt
    sessions       a signed token the browser keeps; it dies when the
                   password changes or after 90 days
    one-time codes for verifying an email and resetting a password
    rate limits    per address, per kind of request, kept in storage
                   so every function instance sees the same counts

  Everything here takes the blob store as an argument so the tests can
  hand it the in-memory shim.
*/

import crypto from "node:crypto";

export const SESSION_DAYS = 90;
export const VERIFY_HOURS = 48;
export const RESET_HOURS = 2;
export const MIN_PASSWORD = 8;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ---------- keys ---------- */

export const userKey = (id) => `users/${id}`;
export const emailKey = (email) => `email/${normalizeEmail(email)}`;
export const tokenKey = (token) => `token/${token}`;
export const slugKey = (slug) => `slug/${slug}`;
const rateKey = (bucket, who) => `rl/${bucket}/${who}`;

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function emailIsValid(email) {
  const value = normalizeEmail(email);
  return Boolean(value) && value.length <= 120 && EMAIL_PATTERN.test(value);
}

/* ---------- passwords ---------- */

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { salt, hash };
}

export function passwordMatches(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(user.hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function passwordProblem(password) {
  const value = String(password || "");
  if (value.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (value.length > 200) return "That password is too long.";
  return null;
}

/* ---------- sessions ---------- */

/*
  The secret that signs sessions: SESSION_SECRET if set, else derived
  from the admin password so a site with only the old variable still
  works. Changing either signs everyone out.
*/
export function sessionSecret(env = process.env) {
  return env.SESSION_SECRET || crypto.createHash("sha256").update("session:" + (env.ADMIN_PASSWORD || "")).digest("hex");
}

export function issueSession(user, env = process.env, now = Date.now()) {
  const expires = now + SESSION_DAYS * 86400000;
  const payload = `${user.id}.${expires}.${user.pwVersion || 1}`;
  const signature = crypto.createHmac("sha256", sessionSecret(env)).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt: new Date(expires).toISOString() };
}

/*
  Reads a session token back to its user id, or null. The password
  version inside must still match the user's, which is what makes a
  password change sign every device out.
*/
export function sessionUserId(token, env = process.env, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4) return null;
  const [id, expires, version, signature] = parts;
  if (!/^\d+$/.test(expires) || Number(expires) < now) return null;
  const expected = crypto.createHmac("sha256", sessionSecret(env)).update(`${id}.${expires}.${version}`).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id, version: Number(version) };
}

/* ---------- users ---------- */

export async function readUser(store, id) {
  if (!id) return null;
  const user = await store.get(userKey(id), { type: "json", consistency: "strong" });
  return user && typeof user === "object" ? user : null;
}

export async function findUserByEmail(store, email) {
  const id = await store.get(emailKey(email), { type: "json", consistency: "strong" });
  return id ? readUser(store, id) : null;
}

export async function writeUser(store, user) {
  await store.setJSON(userKey(user.id), user);
}

export async function createUser(store, { email, password, displayName, calendarId }) {
  const normalized = normalizeEmail(email);
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(),
    email: normalized,
    displayName: String(displayName || "").trim().slice(0, 40) || normalized.split("@")[0],
    salt,
    hash,
    pwVersion: 1,
    calendarId,
    verifiedAt: null,
    createdAt: new Date().toISOString()
  };
  await writeUser(store, user);
  await store.setJSON(emailKey(normalized), user.id);
  return user;
}

/*
  The user a request speaks for, from its session header - or null.
*/
export async function userFromRequest(store, req, env = process.env) {
  const parsed = sessionUserId(req.headers.get("x-session"), env);
  if (!parsed) return null;
  const user = await readUser(store, parsed.id);
  if (!user || (user.pwVersion || 1) !== parsed.version) return null;
  return user;
}

/* ---------- one-time codes ---------- */

export async function issueToken(store, { kind, userId, hours }) {
  const token = crypto.randomBytes(24).toString("base64url");
  await store.setJSON(tokenKey(token), {
    kind, userId, expiresAt: new Date(Date.now() + hours * 3600000).toISOString()
  });
  return token;
}

/*
  Reads a code, checks its kind and age, and burns it: a code works
  once, whatever happens after.
*/
export async function consumeToken(store, token, kind) {
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const record = await store.get(tokenKey(token), { type: "json", consistency: "strong" });
  if (!record) return null;
  await store.delete(tokenKey(token));
  if (record.kind !== kind) return null;
  if (new Date(record.expiresAt).getTime() < Date.now()) return null;
  return record;
}

/* ---------- rate limits ---------- */

export const RATE_LIMITS = {
  signup: { max: 5, minutes: 60 },
  login: { max: 20, minutes: 15 },
  forgot: { max: 5, minutes: 60 },
  request: { max: 12, minutes: 60 },
  verify: { max: 20, minutes: 60 }
};

export function clientAddress(req) {
  return req.headers.get("x-nf-client-connection-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
}

/*
  Counts this address's recent attempts of one kind and refuses past
  the limit. Returns null when allowed, else the seconds to wait.
*/
export async function rateLimit(store, bucket, who, limits = RATE_LIMITS, now = Date.now()) {
  const rule = limits[bucket];
  if (!rule) return null;
  const key = rateKey(bucket, who);
  const window = rule.minutes * 60000;
  const stamps = ((await store.get(key, { type: "json", consistency: "strong" })) || []).filter((t) => now - t < window);
  if (stamps.length >= rule.max) {
    return Math.ceil((stamps[0] + window - now) / 1000);
  }
  stamps.push(now);
  await store.setJSON(key, stamps);
  return null;
}

/* ---------- slugs ---------- */

export function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

export function slugIsValid(slug) {
  return /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/.test(slug || "") && !RESERVED_SLUGS.has(slug);
}

/*
  Paths the site uses itself, or that would read badly as someone's
  calendar.
*/
export const RESERVED_SLUGS = new Set([
  "api", "admin", "login", "signup", "sign-up", "signin", "sign-in", "logout", "verify", "reset",
  "settings", "home", "index", "calendar", "calendars", "app", "static", "assets", "img", "images",
  "feed", "help", "about", "terms", "privacy", "www", "netlify", "new", "me", "account", "dashboard", "calendars", "accounts"
]);

/*
  A free slug near the wanted one: the wanted one, else with -2, -3...
*/
export async function claimSlug(store, wanted, calendarId, previous = null) {
  const base = slugIsValid(wanted) ? wanted : "calendar";
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base.slice(0, 27)}-${n + 1}`;
    const owner = await store.get(slugKey(candidate), { type: "json", consistency: "strong" });
    if (!owner || owner === calendarId) {
      await store.setJSON(slugKey(candidate), calendarId);
      if (previous && previous !== candidate) {
        const previousOwner = await store.get(slugKey(previous), { type: "json", consistency: "strong" });
        if (previousOwner === calendarId) await store.delete(slugKey(previous));
      }
      return candidate;
    }
  }
  throw new Error("No free address near that name.");
}

export async function calendarForSlug(store, slug) {
  if (!slug || !/^[a-z0-9-]{1,30}$/.test(slug)) return null;
  const id = await store.get(slugKey(slug), { type: "json", consistency: "strong" });
  return id || null;
}
