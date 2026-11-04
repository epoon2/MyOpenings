/*
  Google Calendar mirror.

  Every booked session on the schedule is kept as a matching event on
  one Google calendar, titled "Blocked" unless the owner typed a name
  for it in the editor (googleTitle) - never the student's name or the
  notes by default. Availability is never mirrored.

  Setup is two environment variables on Netlify:

    GOOGLE_SERVICE_ACCOUNT_JSON  the JSON key of a Google Cloud service
                                 account (the whole file, as one line)
    GOOGLE_CALENDAR_ID           the id of the calendar to write to,
                                 shared with that service account's
                                 email under "Make changes to events"

  Without both, nothing here runs. With them, every save, skip and
  delete on the portal pushes straight through, and a failure to reach
  Google is reported back to the page but never fails the save itself -
  the portal's own copy is the source of truth, and "Resync" replays it.

  A repeating session becomes one Google event with an RRULE (and EXDATE
  lines for skipped weeks), so a series edit is one update, not fifty.
  The Google event id is derived from the portal's id, which is what
  lets an update find its event without a lookup table.
*/

import crypto from "node:crypto";

const TIMEZONE_ID = "America/Los_Angeles";
const DEFAULT_API_BASE = "https://www.googleapis.com/calendar/v3";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const SOURCE_TAG = "tutoring-availability";
const REQUEST_TIMEOUT_MS = 7000;
const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];


/*
  CONFIG
*/

export function googleSyncSettings(env = process.env, { timeZone = TIMEZONE_ID } = {}) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const calendarId = env.GOOGLE_CALENDAR_ID;
  if (!raw || !calendarId) return null;
  let account;
  try { account = JSON.parse(raw); } catch { return null; }
  if (!account?.client_email || !account?.private_key) return null;
  return {
    account,
    calendarId,
    timeZone,
    apiBase: env.GOOGLE_API_BASE || DEFAULT_API_BASE,
    tokenUrl: env.GOOGLE_TOKEN_URL || DEFAULT_TOKEN_URL
  };
}

export function googleSyncConfigured(env = process.env) {
  return googleSyncSettings(env) !== null;
}


/*
  EVENT MAPPING
*/

/*
  Google event ids may only use a-v and 0-9. Hex is inside that
  alphabet, so a hash of the portal id is a valid, stable Google id.
*/

export function googleEventId(portalId) {
  return "t" + crypto.createHash("sha1").update(String(portalId)).digest("hex");
}


export function buildGoogleEvent(event, timeZone = TIMEZONE_ID) {
  const body = {
    summary: String(event.googleTitle || "").trim() || "Blocked",
    status: "confirmed",
    start: { dateTime: `${event.start}:00`, timeZone },
    end: { dateTime: `${event.end}:00`, timeZone },
    extendedProperties: {
      private: { tutoringId: String(event.id), tutoringSource: SOURCE_TAG }
    }
  };

  /*
    A block painted in the portal shows up in the nearest of Google's
    eleven event colors. Only the event's own color travels: the
    rules that recolor single dates or weekdays of a series stay in
    the portal, since Google has no per-instance color on a series.
    An unpainted block keeps the calendar's own color.
  */
  const colorId = googleColorId(event.color);
  if (colorId) body.colorId = colorId;

  const recurrence = event.recurrence;
  if (recurrence && recurrence.frequency === "WEEKLY") {
    /*
      Google takes DTSTART as the first instance whatever BYDAY says, so
      the event must start on the first day the series really lands on.
    */
    const first = firstOccurrence(event);
    body.start.dateTime = `${first.start}:00`;
    body.end.dateTime = `${first.end}:00`;

    const parts = [
      "FREQ=WEEKLY",
      "WKST=SU",
      `INTERVAL=${recurrence.interval || 1}`,
      `BYDAY=${[...recurrence.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_CODES[d]).join(",")}`
    ];
    if (recurrence.endType === "COUNT") parts.push(`COUNT=${recurrence.count}`);
    if (recurrence.endType === "ON") parts.push(`UNTIL=${rruleUntil(recurrence.until, timeZone)}`);
    body.recurrence = [`RRULE:${parts.join(";")}`];

    const time = event.start.slice(11);
    const exdates = [...new Set(recurrence.exdates || [])].sort();
    if (exdates.length) {
      body.recurrence.push(
        `EXDATE;TZID=${timeZone}:` +
        exdates.map((date) => icsLocal(`${date}T${time}`)).join(",")
      );
    }
  }

  return body;
}


/*
  Google Calendar's event color palette (colorId -> the color it
  paints), matched by nearest RGB distance.
*/

const GOOGLE_EVENT_COLORS = [
  ["1", "#7986cb"],  // Lavender
  ["2", "#33b679"],  // Sage
  ["3", "#8e24aa"],  // Grape
  ["4", "#e67c73"],  // Flamingo
  ["5", "#f6bf26"],  // Banana
  ["6", "#f4511e"],  // Tangerine
  ["7", "#039be5"],  // Peacock
  ["8", "#616161"],  // Graphite
  ["9", "#3f51b5"],  // Blueberry
  ["10", "#0b8043"], // Basil
  ["11", "#d50000"]  // Tomato
];

export function googleColorId(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || "")) return null;
  const target = hsl(hex);
  // a grey has no hue worth matching
  if (target.s < 0.2) return "8";
  let best = null, bestDistance = Infinity;
  for (const [id, sample] of GOOGLE_EVENT_COLORS) {
    if (id === "8") continue;
    const candidate = hsl(sample);
    const hue = Math.abs(target.h - candidate.h);
    // hue first (in degrees, around the wheel), then how light it is
    const distance = Math.min(hue, 360 - hue) + 60 * Math.abs(target.l - candidate.l);
    if (distance < bestDistance) { bestDistance = distance; best = id; }
  }
  return best;
}

function hsl(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s, l };
}


/*
  The portal's weeks start on Sunday and the anchor is the week of the
  series start; the first occurrence is the earliest listed weekday on
  or after the start date, in that week or the next interval week.
*/

export function firstOccurrence(event) {
  const recurrence = event.recurrence;
  const startDate = event.start.slice(0, 10);
  const time = event.start.slice(11);
  const durationMinutes = minutesBetween(event.start, event.end);
  const startDay = utcDay(startDate);
  const weekStart = addDays(startDay, -startDay.getUTCDay());
  const weekdays = [...recurrence.weekdays].sort((a, b) => a - b);
  const interval = recurrence.interval || 1;
  for (let cycle = 0; cycle < 60; cycle++) {
    const week = addDays(weekStart, cycle * interval * 7);
    for (const weekday of weekdays) {
      const day = addDays(week, weekday);
      if (day < startDay) continue;
      const start = `${isoDate(day)}T${time}`;
      return { start, end: addMinutes(start, durationMinutes) };
    }
  }
  return { start: event.start, end: event.end };
}


/*
  RRULE wants UNTIL in UTC; the portal's end date is inclusive and local,
  so UNTIL is the last minute of that day in Los Angeles.
*/

export function rruleUntil(untilDate, timeZone = TIMEZONE_ID) {
  const utc = new Date(zonedLocalToUtc(`${untilDate}T23:59`, timeZone).getTime() + 59000);
  return utc.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function zonedLocalToUtc(local, timeZone) {
  const [date, time] = local.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = (instant) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).formatToParts(new Date(instant));
    const v = {};
    for (const p of parts) v[p.type] = p.value;
    const asUtc = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), Number(v.hour), Number(v.minute));
    return asUtc - instant;
  };
  // two passes settle on the right side of a DST change
  let result = guess - offset(guess);
  result = guess - offset(result);
  return new Date(result);
}


/*
  HTTP
*/

let cachedToken = null;

async function accessToken(settings) {
  if (cachedToken && cachedToken.expires > Date.now() + 60000
      && cachedToken.email === settings.account.client_email) {
    return cachedToken.value;
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: settings.account.client_email,
    scope: SCOPE,
    aud: settings.tokenUrl,
    iat: now,
    exp: now + 3600
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(settings.account.private_key, "base64url");
  const assertion = `${header}.${claims}.${signature}`;

  const response = await timedFetch(settings.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!response.ok) {
    throw new Error(`Google token request failed (${response.status}): ${await safeText(response)}`);
  }
  const data = await response.json();
  cachedToken = {
    value: data.access_token,
    email: settings.account.client_email,
    expires: Date.now() + (Number(data.expires_in) || 3600) * 1000
  };
  return cachedToken.value;
}

export function resetTokenCache() { cachedToken = null; }

async function googleRequest(settings, method, path, body) {
  const token = await accessToken(settings);
  const response = await timedFetch(`${settings.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return response;
}

function calendarPath(settings, suffix = "") {
  return `/calendars/${encodeURIComponent(settings.calendarId)}/events${suffix}`;
}


/*
  One session -> one Google event. Update first, because an id that was
  deleted on Google once is still there as "cancelled" and only an update
  can bring it back; a never-seen id gets an insert.
*/

export async function upsertGoogleEvent(event, settings) {
  const id = googleEventId(event.id);
  const body = { ...buildGoogleEvent(event, settings.timeZone || TIMEZONE_ID), id };
  let response = await googleRequest(settings, "PUT", calendarPath(settings, `/${id}`), body);
  if (response.status === 404) {
    response = await googleRequest(settings, "POST", calendarPath(settings), body);
  }
  if (!response.ok) {
    throw new Error(`Google ${response.status}: ${await safeText(response)}`);
  }
  return id;
}

export async function deleteGoogleEvent(portalId, settings) {
  const id = googleEventId(portalId);
  const response = await googleRequest(settings, "DELETE", calendarPath(settings, `/${id}`));
  // 404 and 410: already gone, which is the state we wanted
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(`Google ${response.status}: ${await safeText(response)}`);
  }
  return id;
}


/*
  ENTRY POINTS FOR THE ROUTES

  Each returns { google: "ok" | "off" | "failed", error? } and never
  throws: the schedule has already been saved by the time these run.
*/

export async function mirrorSavedEvent(event, env = process.env, options = {}) {
  const settings = googleSyncSettings(env, options);
  if (!settings) return { google: "off" };
  try {
    if (event.type === "BLOCKED") {
      await upsertGoogleEvent(event, settings);
    } else {
      // an event edited from booked to available leaves the calendar
      await deleteGoogleEvent(event.id, settings);
    }
    return { google: "ok" };
  } catch (error) {
    console.error("Google sync failed", error);
    return { google: "failed", error: error.message };
  }
}

export async function mirrorDeletedEvent(portalId, env = process.env) {
  const settings = googleSyncSettings(env);
  if (!settings) return { google: "off" };
  try {
    await deleteGoogleEvent(portalId, settings);
    return { google: "ok" };
  } catch (error) {
    console.error("Google sync failed", error);
    return { google: "failed", error: error.message };
  }
}


/*
  After an undo or redo the schedule jumps to a stored snapshot; only
  what differs needs to reach Google. Sessions added or changed are
  pushed, sessions gone are removed, and a session that turned into
  availability is removed too.
*/

export async function mirrorDifference(before, after, env = process.env, options = {}) {
  const settings = googleSyncSettings(env, options);
  if (!settings) return { google: "off" };
  const was = new Map(before.map((event) => [event.id, event]));
  const now = new Map(after.map((event) => [event.id, event]));
  const failed = [];
  let changed = 0;

  for (const [id, event] of now) {
    const previous = was.get(id);
    const same = previous && JSON.stringify(previous) === JSON.stringify(event);
    if (same) continue;
    if (event.type !== "BLOCKED" && !(previous && previous.type === "BLOCKED")) continue;
    changed++;
    try {
      if (event.type === "BLOCKED") await upsertGoogleEvent(event, settings);
      else await deleteGoogleEvent(id, settings);
    } catch (error) {
      failed.push({ id, error: error.message });
    }
  }
  for (const [id, event] of was) {
    if (now.has(id) || event.type !== "BLOCKED") continue;
    changed++;
    try {
      await deleteGoogleEvent(id, settings);
    } catch (error) {
      failed.push({ id, error: error.message });
    }
  }

  if (failed.length) {
    console.error("Google sync failed", failed);
    return { google: "failed", error: failed[0].error, changed, failed };
  }
  return { google: "ok", changed };
}


/*
  Replay the whole schedule: every booked session upserted, and any
  event this portal put on the calendar that no longer has a session
  behind it removed. Used on first setup and after an outage.
*/

export async function resyncAll(events, env = process.env, options = {}) {
  const settings = googleSyncSettings(env, options);
  if (!settings) return { google: "off" };
  const blocked = events.filter((event) => event.type === "BLOCKED");
  const result = { google: "ok", pushed: 0, removed: 0, failed: [] };
  try {
    for (const event of blocked) {
      try {
        await upsertGoogleEvent(event, settings);
        result.pushed++;
      } catch (error) {
        result.failed.push({ id: event.id, error: error.message });
      }
    }

    const keep = new Set(blocked.map((event) => googleEventId(event.id)));
    let pageToken = null;
    do {
      const query = new URLSearchParams({
        privateExtendedProperty: `tutoringSource=${SOURCE_TAG}`,
        showDeleted: "false",
        maxResults: "250"
      });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await googleRequest(settings, "GET", calendarPath(settings, `?${query}`));
      if (!response.ok) throw new Error(`Google ${response.status}: ${await safeText(response)}`);
      const page = await response.json();
      for (const item of page.items || []) {
        if (!keep.has(item.id)) {
          const gone = await googleRequest(settings, "DELETE", calendarPath(settings, `/${item.id}`));
          if (gone.ok || gone.status === 404 || gone.status === 410) result.removed++;
          else result.failed.push({ id: item.id, error: `Google ${gone.status}` });
        }
      }
      pageToken = page.nextPageToken || null;
    } while (pageToken);
  } catch (error) {
    console.error("Google resync failed", error);
    result.google = "failed";
    result.error = error.message;
  }
  if (result.failed.length && result.google === "ok") result.google = "partial";
  return result;
}


/*
  HELPERS
*/

async function timedFetch(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(response) {
  try { return (await response.text()).slice(0, 300); } catch { return ""; }
}

function base64url(text) {
  return Buffer.from(text).toString("base64url");
}

function icsLocal(local) {
  return local.replace(/-/g, "").replace(":", "") + "00";
}

function utcDay(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(day, n) {
  return new Date(day.getTime() + n * 86400000);
}

function isoDate(day) {
  return day.toISOString().slice(0, 10);
}

function minutesBetween(a, b) {
  return (wallMs(b) - wallMs(a)) / 60000;
}

function addMinutes(local, minutes) {
  const d = new Date(wallMs(local) + minutes * 60000);
  return d.toISOString().slice(0, 16);
}

function wallMs(local) {
  const [date, time] = local.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm);
}
