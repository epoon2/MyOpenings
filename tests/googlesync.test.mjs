// The Google Calendar mirror: how a session maps to a Google event, and
// what the routes send to Google - against a fake Google that checks the
// service-account JWT for real.
// Run: node tests/install-shim.mjs && node tests/googlesync.test.mjs
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import {
  buildGoogleEvent, googleEventId, firstOccurrence, rruleUntil, zonedLocalToUtc, googleColorId,
  googleSyncSettings, resetTokenCache
} from '../netlify/functions/googlesync.mjs';

let ran = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  ran++;
  if (cond) console.log('  ok ' + name);
  else fails.push(name + (extra ? `\n    ${extra}` : ''));
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);

// ---- ids and time
ok('Google ids use only a-v and 0-9', /^[a-v0-9]{5,}$/.test(googleEventId('9b0c-uuid')));
ok('and are stable', googleEventId('x') === googleEventId('x') && googleEventId('x') !== googleEventId('y'));
eq('summer local time converts to UTC at -7', zonedLocalToUtc('2026-07-15T16:00', 'America/Los_Angeles').toISOString(), '2026-07-15T23:00:00.000Z');
eq('winter local time converts to UTC at -8', zonedLocalToUtc('2026-12-15T16:00', 'America/Los_Angeles').toISOString(), '2026-12-16T00:00:00.000Z');
eq('UNTIL is the last second of the end date, in UTC', rruleUntil('2026-12-15'), '20261216T075959Z');

// ---- mapping
const oneOff = { id: 'one', type: 'BLOCKED', title: 'Maya - Algebra II', notes: 'secret',
  start: '2026-09-11T10:00', end: '2026-09-11T11:30', recurrence: null };
const g1 = buildGoogleEvent(oneOff);
eq('a one-off is a plain Blocked event in Los Angeles time', g1, {
  summary: 'Blocked', status: 'confirmed',
  start: { dateTime: '2026-09-11T10:00:00', timeZone: 'America/Los_Angeles' },
  end: { dateTime: '2026-09-11T11:30:00', timeZone: 'America/Los_Angeles' },
  extendedProperties: { private: { tutoringId: 'one', tutoringSource: 'tutoring-availability' } }
});
ok('no name or notes reach Google', !JSON.stringify(g1).includes('Maya') && !JSON.stringify(g1).includes('secret'));
ok('an unpainted block sets no colorId', !('colorId' in g1));
eq('a name the owner typed for Google is the summary instead', buildGoogleEvent({ ...oneOff, googleTitle: 'Algebra with M.' }).summary, 'Algebra with M.');
eq('a blank one falls back to Blocked', buildGoogleEvent({ ...oneOff, googleTitle: '   ' }).summary, 'Blocked');

// ---- colors: the nearest of Google's eleven
eq('the portal palette lands on sensible Google colors',
  ['#b42318', '#c2410c', '#a16207', '#2f7d4a', '#0f766e', '#1d4ed8', '#6d28d9', '#4b5563'].map(googleColorId),
  ['11', '6', '5', '10', '10', '9', '3', '8']);
eq('a custom light yellow is Banana, a grey is Graphite, nothing is nothing',
  [googleColorId('#ffcc00'), googleColorId('#888888'), googleColorId(undefined), googleColorId('red')], ['5', '8', null, null]);
eq('a painted block carries its colorId', buildGoogleEvent({ ...oneOff, color: '#1d4ed8' }).colorId, '9');
ok('color rules on a series stay in the portal - only the series color travels',
  buildGoogleEvent({ id: 'r', type: 'BLOCKED', title: 't', start: '2026-09-08T16:00', end: '2026-09-08T17:00', color: '#6d28d9',
    recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4], endType: 'NEVER', colorRules: [{ weekday: 4, color: '#1d4ed8' }] } }).colorId === '3');

// Tue/Thu series anchored on a Tuesday, every week, no end
const series = { id: 'series', type: 'BLOCKED', title: 'Maya - Algebra II',
  start: '2026-09-08T16:00', end: '2026-09-08T17:00',
  recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4], endType: 'NEVER' } };
eq('a weekly series is one RRULE', buildGoogleEvent(series).recurrence,
  ['RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=1;BYDAY=TU,TH']);

// anchored on a Monday but only landing Wed/Fri: the first instance is the Wednesday
const offAnchor = { ...series, start: '2026-09-07T16:00', end: '2026-09-07T17:00',
  recurrence: { frequency: 'WEEKLY', interval: 2, weekdays: [5, 3], endType: 'COUNT', count: 6 } };
eq('the first occurrence is the first listed weekday on or after the start',
  firstOccurrence(offAnchor), { start: '2026-09-09T16:00', end: '2026-09-09T17:00' });
const g2 = buildGoogleEvent(offAnchor);
eq('and Google starts there, so the anchor day is not a bonus session', g2.start.dateTime, '2026-09-09T16:00:00');
eq('interval, sorted weekdays and COUNT carry over', g2.recurrence,
  ['RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=2;BYDAY=WE,FR;COUNT=6']);

// a Sunday anchor whose only weekday is Saturday, every 3 weeks: skips to that week's Saturday
const sat = { ...series, start: '2026-09-06T09:00', end: '2026-09-06T10:00',
  recurrence: { frequency: 'WEEKLY', interval: 3, weekdays: [6], endType: 'NEVER' } };
eq('a same-week later weekday is still the first', firstOccurrence(sat).start, '2026-09-12T09:00');

// a start after every listed weekday of its week rolls to the next interval week
const late = { ...series, start: '2026-09-11T16:00', end: '2026-09-11T17:00',
  recurrence: { frequency: 'WEEKLY', interval: 2, weekdays: [2], endType: 'NEVER' } };
eq('a start past the week\'s weekdays rolls to the next interval week', firstOccurrence(late).start, '2026-09-22T16:00');

const ending = { ...series, recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4],
  endType: 'ON', until: '2026-10-15', exdates: ['2026-09-17', '2026-09-10'] } };
eq('an end date becomes UNTIL and skipped weeks become EXDATE at the session time',
  buildGoogleEvent(ending).recurrence, [
    'RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=1;BYDAY=TU,TH;UNTIL=20261016T065959Z',
    'EXDATE;TZID=America/Los_Angeles:20260910T160000,20260917T160000'
  ]);

// a series crossing midnight keeps its length on the first occurrence
const lateNight = { ...offAnchor, start: '2026-09-07T23:00', end: '2026-09-08T00:30' };
eq('a session over midnight keeps its 90 minutes', firstOccurrence(lateNight),
  { start: '2026-09-09T23:00', end: '2026-09-10T00:30' });

// ---- settings
ok('no credentials means sync is off', googleSyncSettings({}) === null);
ok('unparseable credentials mean off, not a crash',
  googleSyncSettings({ GOOGLE_SERVICE_ACCOUNT_JSON: '{nope', GOOGLE_CALENDAR_ID: 'c' }) === null);

// ---- a fake Google, with a real key
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  client_email: 'portal@example.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
};
const calls = [];
let store = new Map();          // google id -> event body

let broken = false;
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => raw += c);
  req.on('end', () => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (broken) return send(503, { error: 'down' });
    if (req.url === '/token') {
      const assertion = new URLSearchParams(raw).get('assertion');
      const [h, c, s] = assertion.split('.');
      const verified = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
      const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
      calls.push({ method: 'TOKEN', verified, iss: claims.iss, scope: claims.scope });
      if (!verified) return send(401, { error: 'bad signature' });
      return send(200, { access_token: 'tok-1', expires_in: 3600 });
    }
    if (req.headers.authorization !== 'Bearer tok-1') return send(401, { error: 'no token' });
    const url = new URL(req.url, 'http://x');
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return send(404, { error: 'route' });
    const [, cal, id] = m;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, cal: decodeURIComponent(cal), id, body, query: url.search });
    if (req.method === 'PUT') {
      if (!store.has(id)) return send(404, { error: 'not found' });
      store.set(id, body); return send(200, body);
    }
    if (req.method === 'POST') { store.set(body.id, body); return send(200, body); }
    if (req.method === 'DELETE') {
      if (!store.has(id)) return send(404, {});
      store.delete(id); res.writeHead(204); return res.end();
    }
    if (req.method === 'GET') {
      return send(200, { items: [...store.entries()].map(([k, v]) => ({ id: k, ...v })) });
    }
    send(405, {});
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fake.address().port}`;

process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(account);
process.env.GOOGLE_CALENDAR_ID = 'ethan@example.com';
process.env.GOOGLE_API_BASE = base;
process.env.GOOGLE_TOKEN_URL = `${base}/token`;
resetTokenCache();

const { default: handler } = await import('../netlify/functions/api.mjs');
const { getStore } = await import('@netlify/blobs');
process.env.ADMIN_PASSWORD = 't';
const call = (method, path, body) => handler(new Request('http://localhost/api' + path, {
  method, headers: { 'x-admin-password': 't', 'Content-Type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined
}));
const portalEvents = async () => getStore('tutoring-availability').get('events-v2', { type: 'json' });

// save a booked session
let res = await call('POST', '/events', { type: 'BLOCKED', title: 'Maya - Algebra II', notes: 'n',
  start: '2026-09-11T10:00', end: '2026-09-11T11:00', recurrence: null });
let data = await res.json();
ok('a booked session saves and reports the Google push', res.status === 200 && data.sync?.google === 'ok', JSON.stringify(data));
const token = calls.find((c) => c.method === 'TOKEN');
ok('the service-account JWT is signed with the key and asks for the events scope',
  token && token.verified && token.iss === account.client_email && token.scope.endsWith('/auth/calendar.events'));
const gid = googleEventId(data.id);
eq('an unseen event is tried as an update, then inserted with its derived id',
  calls.filter((c) => c.method !== 'TOKEN').map((c) => c.method + (c.id ? ':' + c.id : '')),
  ['PUT:' + gid, 'POST']);
ok('the insert names the calendar and the id', calls[2].cal === 'ethan@example.com' && calls[2].body.id === gid);
ok('what Google got is a plain Blocked block', store.get(gid).summary === 'Blocked' && !JSON.stringify(store.get(gid)).includes('Maya'));

// edit it: now it exists on Google, so it is a single update
calls.length = 0;
res = await call('POST', '/events', { id: data.id, type: 'BLOCKED', title: 'Maya - Algebra II',
  start: '2026-09-11T11:00', end: '2026-09-11T12:00', recurrence: null });
eq('an edit is one PUT', calls.map((c) => c.method), ['PUT']);
ok('and the token is reused', !calls.some((c) => c.method === 'TOKEN'));
ok('Google now has the moved time', store.get(gid).start.dateTime === '2026-09-11T11:00:00');

// availability never goes to Google
calls.length = 0;
res = await call('POST', '/events', { type: 'AVAILABLE', title: 'Open',
  start: '2026-09-12T09:00', end: '2026-09-12T12:00', recurrence: null });
const avail = await res.json();
ok('availability is not pushed (only a no-op delete for safety)',
  avail.sync.google === 'ok' && calls.every((c) => c.method === 'DELETE'), JSON.stringify(calls));

// a series, then skipping a week, then deleting it
calls.length = 0;
res = await call('POST', '/events', { type: 'BLOCKED', title: 'Noah - Geometry',
  start: '2026-09-08T16:00', end: '2026-09-08T17:00',
  recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4], endType: 'NEVER' } });
const seriesData = await res.json();
const sid = googleEventId(seriesData.id);
ok('a series lands as one recurring event', store.get(sid)?.recurrence?.[0] === 'RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=1;BYDAY=TU,TH');
calls.length = 0;
res = await call('POST', `/events/${seriesData.id}/skip`, { date: '2026-09-17' });
data = await res.json();
ok('skipping a week re-pushes the series with an EXDATE', data.sync?.google === 'ok'
  && store.get(sid).recurrence[1] === 'EXDATE;TZID=America/Los_Angeles:20260917T160000', JSON.stringify(store.get(sid).recurrence));
calls.length = 0;
res = await call('DELETE', `/events/${seriesData.id}`);
data = await res.json();
ok('deleting removes it from Google', data.sync?.google === 'ok' && !store.has(sid) && calls[0].method === 'DELETE' && calls[0].id === sid);

// Google down: the portal still saves, and says the mirror failed
broken = true;
resetTokenCache();
calls.length = 0;
res = await call('POST', '/events', { type: 'BLOCKED', title: 'Ava - Chem',
  start: '2026-09-14T13:00', end: '2026-09-14T14:00', recurrence: null });
data = await res.json();
ok('with Google down the save still succeeds', res.status === 200 && data.id);
ok('and reports the failure instead of hiding it', data.sync?.google === 'failed' && /503/.test(data.sync.error), JSON.stringify(data.sync));
ok('the portal kept the session', (await portalEvents()).some((e) => e.id === data.id));
const missing = googleEventId(data.id);

// resync: pushes what Google missed, removes what the portal no longer has
broken = false;
store.set('tdeadbeef', { summary: 'Blocked', extendedProperties: { private: { tutoringSource: 'tutoring-availability' } } });
calls.length = 0;
res = await call('POST', '/google/resync', {});
data = await res.json();
ok('resync pushes every booked session', data.google === 'ok' && data.pushed === 2, JSON.stringify(data));
ok('the session Google missed is there now', store.has(missing));
ok('a stale mirrored event is removed', data.removed === 1 && !store.has('tdeadbeef'));
ok('the listing asks Google only for this portal\'s events',
  calls.some((c) => c.method === 'GET' && c.query.includes('privateExtendedProperty=tutoringSource%3Dtutoring-availability')));
ok('availability is not part of the resync', !calls.some((c) => c.body && c.body.start?.dateTime === '2026-09-12T09:00:00'));

// resync needs admin
res = await handler(new Request('http://localhost/api/google/resync', { method: 'POST' }));
ok('resync is admin-only', res.status === 401 || res.status === 403, String(res.status));

// with no credentials the routes say "off" and touch nothing
delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
calls.length = 0;
res = await call('POST', '/events', { type: 'BLOCKED', title: 'Z', start: '2026-09-15T13:00', end: '2026-09-15T14:00', recurrence: null });
data = await res.json();
ok('without credentials the save reports sync off and calls nothing', data.sync?.google === 'off' && calls.length === 0);

fake.close();
console.log(fails.length ? '\nFAILED:\n  ' + fails.join('\n  ') : `\ngooglesync: all ${ran} checks passed`);
process.exit(fails.length ? 1 : 0);
