/*
  Calendar feed.

  One private iCal feed of the booked sessions, behind a secret token,
  for Google Calendar (or any calendar) to subscribe to:

    /api/feed/<token>/tutoring.ics

  Every session is a plain "Tutoring" block - no student name, no
  notes - and availability never appears. Repeating sessions arrive
  already expanded into single dated blocks (skipped weeks omitted,
  count and end-date limits honoured), because that is the form every
  calendar reads identically; RRULE dialects are not.
*/

import crypto from "node:crypto";

import { zonedLocalToUtc } from "./googlesync.mjs";

const TIMEZONE_ID = "America/Los_Angeles";
const PRODID = "-//Tutoring Availability//Feed//EN";
const UID_DOMAIN = "tutoring-availability";

/*
  How far the feed reaches. Past weeks stay so a calendar that already
  imported them does not watch them vanish; the year ahead is far more
  than a subscribed calendar ever shows.
*/
export const FEED_WEEKS_BACK = 4;
export const FEED_WEEKS_AHEAD = 52;

const MIN_TOKEN_LENGTH = 16;


/*
  The token lives in the CALENDAR_FEED_TOKEN environment variable. A
  missing or short token turns the feed off entirely rather than serving
  it behind something guessable.
*/

export function feedTokenIsValid(candidate, configured = process.env.CALENDAR_FEED_TOKEN) {
  if (typeof configured !== "string" || configured.length < MIN_TOKEN_LENGTH) return false;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(configured).digest();
  return crypto.timingSafeEqual(a, b);
}


/*
  Only booked sessions, sorted, each carrying a UID that is stable across
  refreshes: the series id plus the date, so a moved week updates in
  place instead of duplicating.
*/

export function feedSessions(expanded) {
  return expanded
    .filter((event) => event.type === "BLOCKED")
    .map((event) => {
      const seriesId = event.masterId || event.id;
      return {
        id: `${seriesId}-${event.start.slice(0, 10).replace(/-/g, "")}`,
        start: event.start,
        end: event.end
      };
    })
    .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : 1);
}


/*
  Los Angeles times ride with the VTIMEZONE below, as they always have.
  Any other zone (a setting the admin can change) is written in UTC,
  which every calendar reads without a timezone definition.
*/
export function buildIcs(expanded, { calendarName = "Tutoring", generatedAt = new Date(), timeZone = TIMEZONE_ID } = {}) {
  const stamp = icsUtcStamp(generatedAt);
  const local = timeZone === TIMEZONE_ID;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(calendarName)}`,
    `X-WR-TIMEZONE:${timeZone}`,
    ...(local ? LOS_ANGELES_VTIMEZONE : [])
  ];
  const when = (value) => local
    ? `;TZID=${TIMEZONE_ID}:${icsLocal(value)}`
    : `:${icsUtcStamp(zonedLocalToUtc(value, timeZone))}`;

  for (const session of feedSessions(expanded)) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${session.id}@${UID_DOMAIN}`,
      `DTSTAMP:${stamp}`,
      `DTSTART${when(session.start)}`,
      `DTEND${when(session.end)}`,
      "SUMMARY:Tutoring",
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}


/*
  ICS mechanics: local wall-clock stamps, text escaping, and the 75-octet
  line fold the format requires.
*/

function icsLocal(local) {
  // "2026-09-09T16:00" -> "20260909T160000"
  return local.replace(/-/g, "").replace(":", "") + "00";
}

function icsUtcStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function icsText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

export function foldIcsLine(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const pieces = [];
  let from = 0;
  let limit = 75;
  while (from < bytes.length) {
    let to = Math.min(from + limit, bytes.length);
    // never split inside a multi-byte character
    while (to < bytes.length && (bytes[to] & 0xC0) === 0x80) to--;
    pieces.push((pieces.length ? " " : "") + bytes.subarray(from, to).toString("utf8"));
    from = to;
    limit = 74;
  }
  return pieces.join("\r\n");
}

const LOS_ANGELES_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  `TZID:${TIMEZONE_ID}`,
  "BEGIN:STANDARD",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "TZOFFSETFROM:-0700",
  "TZOFFSETTO:-0800",
  "TZNAME:PST",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "TZOFFSETFROM:-0800",
  "TZOFFSETTO:-0700",
  "TZNAME:PDT",
  "END:DAYLIGHT",
  "END:VTIMEZONE"
];
