// Accounts: sign up, confirm the email, log in, one calendar each; the
// first calendar is claimed with the admin password and keeps what it
// already had; passwords reset by email; addresses; rate limits.
// Run: node tests/install-shim.mjs && node tests/accounts.test.mjs
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';

process.env.ADMIN_PASSWORD = 'admin-pw';
// Netlify sets SITE_NAME to the site's Netlify name; the code must not read it.
process.env.SITE_NAME = 'ethan-calendar';
process.env.MASTER_EMAIL = 'ethan@example.com';   // the account that claims the first calendar below   // else the host would be read as "Site Test"

// a fake Brevo that keeps every message, and a fake Google that keeps
// every pushed event per calendar
const sent = [];
const pushed = {};
const fake = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => raw += c);
  req.on('end', () => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/smtp/email') {
      const body = JSON.parse(raw || '{}');
      sent.push({ to: body.to[0].email, subject: body.subject, text: body.textContent, html: body.htmlContent, sender: body.sender });
      return send(201, { messageId: 'x' });
    }
    if (url.pathname === '/token') return send(200, { access_token: 'tok', expires_in: 3600 });
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return send(404, {});
    const cal = decodeURIComponent(m[1]);
    pushed[cal] = pushed[cal] || new Map();
    const body = raw ? JSON.parse(raw) : null;
    if (req.method === 'PUT') { if (!pushed[cal].has(m[2])) return send(404, {}); pushed[cal].set(m[2], body); return send(200, body); }
    if (req.method === 'POST') { pushed[cal].set(body.id, body); return send(200, body); }
    if (req.method === 'DELETE') { pushed[cal].delete(m[2]); res.writeHead(204); return res.end(); }
    if (req.method === 'GET') return send(200, { items: [...pushed[cal].values()] });
    return send(405, {});
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
process.env.BREVO_API_KEY = 'k';
process.env.NOTIFY_FROM_EMAIL = 'site@example.com';
process.env.BREVO_API_BASE = `http://127.0.0.1:${fake.address().port}`;
{
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'portal@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  process.env.GOOGLE_CALENDAR_ID = 'ethan-site@group.calendar.google.com';   // the site-wide target the first calendar had
  process.env.GOOGLE_API_BASE = `http://127.0.0.1:${fake.address().port}`;
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${fake.address().port}/token`;
  process.env.CALENDAR_FEED_TOKEN = 'site-feed-token-0123456789';
}

const { default: handler } = await import('../netlify/functions/api.mjs');

let ran = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  ran++;
  if (cond) console.log('  ok ' + name);
  else fails.push(name + (extra ? `\n    ${extra}` : ''));
};
const call = async (method, path, headers = {}, body) => {
  const res = await handler(new Request('http://site.test/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, data: await res.json(), headers: res.headers };
};
const linkIn = (mail) => (/https?:\/\/\S+/.exec(mail.text) || [])[0];
const param = (link, name) => new URL(link).searchParams.get(name);
const week = '?start=2026-09-06&end=2026-09-12';

// ---- the first calendar has a schedule already
let r = await call('POST', '/events', { 'x-admin-password': 'admin-pw' }, { type: 'BLOCKED', title: 'Noah', start: '2026-09-09T10:00', end: '2026-09-09T11:00', recurrence: null });
ok('the first calendar takes a block with the admin password, as before', r.status === 200, JSON.stringify(r.data));
r = await call('GET', '/events' + week);
ok('with no address the request means the first calendar', r.data.mode === 'public' && r.data.calendar.slug === 'ethan' && r.data.calendar.claimed === false, JSON.stringify(r.data.calendar));
r = await call('GET', '/events' + week + '&calendar=ethan', { 'x-admin-password': 'admin-pw' });
ok('/ethan is the first calendar, from the display name', r.data.mode === 'admin' && r.data.events.length === 1);
r = await call('GET', '/events' + week + '&calendar=nobody');
ok('an unknown address is a 404 that says so', r.status === 404 && r.data.missing === true);

// ---- sign-up checks
r = await call('POST', '/signup', {}, { email: 'not-an-email', password: 'longenough1' });
ok('a bad email is refused', r.status === 400);
r = await call('POST', '/signup', {}, { email: 'maya@example.com', password: 'short' });
ok('a short password is refused', r.status === 400 && /8 characters/.test(r.data.error));

// ---- a new account
r = await call('POST', '/signup', {}, { email: 'Maya@Example.com', password: 'maya-pass-1', displayName: 'Maya Chen' });
ok('sign-up creates the account and a session', r.status === 201 && typeof r.data.token === 'string' && r.data.account.email === 'maya@example.com', JSON.stringify(r.data));
ok('the calendar address comes from the name', r.data.account.slug === 'maya-chen' && r.data.account.url === 'http://site.test/maya-chen');
ok('and is not confirmed yet', r.data.account.verified === false && r.data.verification === 'sent');
const maya = r.data.token;
ok('a confirmation email went out', sent.length === 1 && sent[0].to === 'maya@example.com' && /Confirm/.test(sent[0].subject) && sent[0].sender.name === 'MyOpenings', JSON.stringify(sent[0]));
const verifyLink = linkIn(sent[0]);
ok('with a link to the home page carrying a code', verifyLink && verifyLink.startsWith('http://site.test/?verify='), verifyLink);

r = await call('GET', '/events' + week + '&calendar=maya-chen');
ok('until then the calendar is not public', r.status === 404 && r.data.unpublished === true);
r = await call('GET', '/events' + week + '&calendar=maya-chen', { 'x-session': maya });
ok('but the owner sees it, empty, in admin mode', r.status === 200 && r.data.mode === 'admin' && r.data.events.length === 0 && r.data.session === 'valid');
ok('with a fresh title and their own email for notifications', r.data.config.portalTitle === "Maya Chen's Calendar" && r.data.config.tutorName === 'Maya Chen');
r = await call('GET', '/settings?calendar=maya-chen', { 'x-session': maya });
ok('the settings carry the notification address and the slug', r.data.settings.notificationEmail === 'maya@example.com' && r.data.slug === 'maya-chen');
r = await call('GET', '/events' + week + '&calendar=ethan', { 'x-session': maya });
ok("a signed-in account is a visitor on someone else's calendar", r.data.mode === 'public' && r.data.session === 'valid' && r.data.account.slug === 'maya-chen');
r = await call('POST', '/events?calendar=ethan', { 'x-session': maya }, { type: 'BLOCKED', title: 'X', start: '2026-09-09T10:00', end: '2026-09-09T11:00', recurrence: null });
ok('and cannot write there', r.status === 401 && /not your calendar/.test(r.data.error));
r = await call('POST', '/events?calendar=maya-chen', { 'x-session': maya }, { type: 'BLOCKED', title: 'Lee', start: '2026-09-09T12:00', end: '2026-09-09T13:00', recurrence: null });
ok('but can write to their own', r.status === 200);
r = await call('GET', '/events' + week + '&calendar=ethan', { 'x-admin-password': 'admin-pw' });
ok("which does not touch the first calendar's schedule", r.data.events.length === 1 && r.data.events[0].title === 'Noah');

// ---- confirming
r = await call('POST', '/verify', {}, { token: 'nonsense' });
ok('a bad code is refused', r.status === 400);
r = await call('POST', '/verify', {}, { token: param(verifyLink, 'verify') });
ok('the code from the email confirms the account and signs the device in', r.status === 200 && r.data.account.verified === true && typeof r.data.token === 'string');
r = await call('POST', '/verify', {}, { token: param(verifyLink, 'verify') });
ok('and works once', r.status === 400);
r = await call('GET', '/events' + week + '&calendar=maya-chen');
ok('now the calendar is public', r.status === 200 && r.data.mode === 'public' && r.data.calendar.claimed === true);
ok('public responses are cached per calendar', r.headers.get('Netlify-Cache-Tag') !== 'events' && (r.headers.get('Vary') || '').includes('x-session'));
r = await call('POST', '/resend', { 'x-session': maya });
ok('resend after confirming says it is done', r.data.verification === 'done');

// ---- logging in
r = await call('POST', '/login', {}, { email: 'maya@example.com', password: 'wrong-pass' });
ok('a wrong password is refused without saying which half was wrong', r.status === 401 && /do not match/.test(r.data.error));
r = await call('POST', '/login', {}, { email: 'nobody@example.com', password: 'wrong-pass' });
ok('so is an unknown email, the same way', r.status === 401 && /do not match/.test(r.data.error));
r = await call('POST', '/login', {}, { email: '  MAYA@example.com ', password: 'maya-pass-1' });
ok('the right pair signs in, whatever the case and spaces', r.status === 200 && r.data.account.slug === 'maya-chen');
const maya2 = r.data.token;
r = await call('GET', '/me', { 'x-session': maya2 });
ok('/me names the account', r.data.account.email === 'maya@example.com' && r.data.account.verified === true);
r = await call('GET', '/me', { 'x-session': maya2 + 'x' });
ok('a tampered session is nobody', r.status === 401);
r = await call('GET', '/events' + week + '&calendar=maya-chen', { 'x-session': maya2 + 'x' });
ok('and the page is told so', r.data.session === 'invalid' && r.data.mode === 'public');
r = await call('POST', '/signup', {}, { email: 'maya@example.com', password: 'another-pass', displayName: 'Maya' });
ok('the same email cannot sign up twice', r.status === 409);

// ---- the calendar address
r = await call('PUT', '/settings?calendar=maya-chen', { 'x-session': maya2 }, { slug: 'Ethan' });
ok("an address someone else holds is refused", r.status === 400 && /taken/.test(r.data.error));
r = await call('PUT', '/settings?calendar=maya-chen', { 'x-session': maya2 }, { slug: 'api' });
ok('so is a word the site uses', r.status === 400);
r = await call('PUT', '/settings?calendar=maya-chen', { 'x-session': maya2 }, { slug: 'maya' });
ok('a free one is taken on', r.status === 200 && r.data.slug === 'maya');
r = await call('GET', '/events' + week + '&calendar=maya', { 'x-session': maya2 });
ok('and the calendar answers there', r.status === 200 && r.data.mode === 'admin' && r.data.events.length === 1, JSON.stringify(r.data));
r = await call('GET', '/events' + week + '&calendar=maya-chen');
ok('while the old address is free again', r.status === 404);
r = await call('POST', '/signup', {}, { email: 'second@example.com', password: 'second-pass', displayName: 'Maya Chen' });
ok('a second Maya Chen gets the old address back, since it is free', r.status === 201 && r.data.account.slug === 'maya-chen', JSON.stringify(r.data.account));
r = await call('POST', '/signup', {}, { email: 'third@example.com', password: 'third-pass!', displayName: 'Maya Chen' });
ok('a third gets a numbered one', r.status === 201 && r.data.account.slug === 'maya-chen-2', JSON.stringify(r.data.account));
r = await call('POST', '/signup', {}, { email: 'fourth@example.com', password: 'fourth-pass', displayName: 'Anyone', slug: 'maya' });
ok('a chosen address that is taken is refused up front', r.status === 400 && /taken/.test(r.data.error));

// ---- password reset
sent.length = 0;
r = await call('POST', '/forgot', {}, { email: 'nobody@example.com' });
ok('forgot for an unknown email says so, so a typo can be fixed', r.status === 404 && /no account/.test(r.data.error) && sent.length === 0, JSON.stringify(r.data));
r = await call('POST', '/forgot', {}, { email: 'maya@example.com' });
ok('a known one gets an email', r.status === 200 && sent.length === 1 && /Reset/.test(sent[0].subject));
const resetLink = linkIn(sent[0]);
r = await call('POST', '/reset', {}, { token: param(resetLink, 'reset'), password: 'short' });
ok('a reset needs a proper password', r.status === 400);
r = await call('POST', '/reset', {}, { token: param(resetLink, 'reset'), password: 'maya-pass-2' });
ok('the code and a new password sign the device in', r.status === 200 && typeof r.data.token === 'string');
const maya3 = r.data.token;
r = await call('GET', '/me', { 'x-session': maya2 });
ok('every older session is signed out', r.status === 401);
r = await call('GET', '/me', { 'x-session': maya3 });
ok('the new one works', r.status === 200);
r = await call('POST', '/login', {}, { email: 'maya@example.com', password: 'maya-pass-1' });
ok('the old password no longer does', r.status === 401);
r = await call('POST', '/reset', {}, { token: param(resetLink, 'reset'), password: 'maya-pass-3' });
ok('a reset code works once', r.status === 400);

r = await call('POST', '/account/password', { 'x-session': maya3 }, { current: 'wrong', password: 'maya-pass-4' });
ok('changing the password needs the current one', r.status === 401);
r = await call('POST', '/account/password', { 'x-session': maya3 }, { current: 'maya-pass-2', password: 'maya-pass-4' });
ok('and then signs everything else out', r.status === 200 && (await call('GET', '/me', { 'x-session': maya3 })).status === 401 && (await call('GET', '/me', { 'x-session': r.data.token })).status === 200);

// ---- claiming the first calendar
r = await call('POST', '/signup', {}, { email: 'ethan@example.com', password: 'ethan-pass-1', displayName: 'Ethan', adminPassword: 'nope' });
ok('the first calendar needs the right admin password', r.status === 401);
r = await call('POST', '/signup', {}, { email: 'ethan@example.com', password: 'ethan-pass-1', displayName: 'Ethan', adminPassword: 'nope' });
ok('five sign-ups an hour from one address is the limit', r.status === 429, JSON.stringify(r.data));
const home = { 'x-forwarded-for': '10.0.0.2, 10.0.0.1' };
r = await call('POST', '/signup', home, { email: 'ethan@example.com', password: 'ethan-pass-1', displayName: 'Ethan', adminPassword: 'admin-pw' });
ok('with it, the account takes over the first calendar', r.status === 201 && r.data.account.slug === 'ethan', JSON.stringify(r.data));
const ethan = r.data.token;
r = await call('GET', '/events' + week + '&calendar=ethan', { 'x-session': ethan });
ok('with everything it had', r.data.mode === 'admin' && r.data.events.length === 1 && r.data.events[0].title === 'Noah' && r.data.calendar.claimed === true);
ok('and it stays public before the email is confirmed', (await call('GET', '/events' + week + '&calendar=ethan')).status === 200);
r = await call('GET', '/settings?calendar=ethan', { 'x-session': ethan });
ok('the notification address is filled in from the account', r.data.settings.notificationEmail === 'ethan@example.com');
r = await call('GET', '/events' + week, { 'x-admin-password': 'admin-pw' });
ok('the admin password alone no longer opens it', r.data.mode === 'public');
r = await call('POST', '/signup', home, { email: 'other@example.com', password: 'other-pass-1', displayName: 'Other', adminPassword: 'admin-pw' });
ok('nor can it be claimed twice', r.status === 409);

// ---- rate limits
for (let i = 0; i < 20; i++) await call('POST', '/login', {}, { email: `x${i}@example.com`, password: 'nope-nope' });
r = await call('POST', '/login', {}, { email: 'maya@example.com', password: 'maya-pass-4' });
ok('too many logins from one address are held off', r.status === 429 && /try again/.test(r.data.error), JSON.stringify(r.data));
const store = getStore('tutoring-availability');
const soon = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);   // inside the default 12-week window
for (let i = 0; i < 12; i++) await call('POST', '/requests', {}, { name: 'A', email: 'a@example.com', subject: 'Math', format: 'Online', start: soon + 'T10:00', end: soon + 'T11:00', recurrence: null });
r = await call('POST', '/requests', {}, { name: 'A', email: 'a@example.com', subject: 'Math', format: 'Online', start: soon + 'T10:00', end: soon + 'T11:00', recurrence: null });
ok('so are session requests', r.status === 429, JSON.stringify(r.data));
ok('the counts live in storage, not memory', await store.get('rl/login/unknown', { type: 'json' }) !== null);

// ---- Google and the feed, per calendar
ok("the first calendar's block went to the site's Google calendar", pushed['ethan-site@group.calendar.google.com'] && pushed['ethan-site@group.calendar.google.com'].size === 1);
ok("Maya's went nowhere: she has chosen no Google calendar", Object.keys(pushed).length === 1, JSON.stringify(Object.keys(pushed)));
const mayaNow = (await call('POST', '/login', { 'x-forwarded-for': '10.0.0.3' }, { email: 'maya@example.com', password: 'maya-pass-4' })).data.token;
r = await call('GET', '/settings?calendar=maya', { 'x-session': mayaNow });
ok('Settings tells her the service account to share with, and that no calendar is chosen', r.data.google.available && r.data.google.serviceAccountEmail === 'portal@example.iam.gserviceaccount.com' && r.data.google.calendarId === '' && r.data.config.googleSync === false, JSON.stringify(r.data.google));
ok('and gives her a feed address of her own', /\/api\/feed\/[A-Za-z0-9_-]{20,}\/maya\.ics$/.test(r.data.feed.url), r.data.feed.url);
const mayaFeed = r.data.feed.url;
r = await call('PUT', '/settings?calendar=maya', { 'x-session': mayaNow }, { googleCalendarId: 'not a calendar id' });
ok('a Google Calendar ID must look like an address', r.status === 400);
r = await call('PUT', '/settings?calendar=maya', { 'x-session': mayaNow }, { googleCalendarId: 'maya-cal@group.calendar.google.com' });
ok('choosing one pushes everything she has to it', r.status === 200 && r.data.config.googleSync === true && r.data.sync && r.data.sync.google === 'ok'
  && pushed['maya-cal@group.calendar.google.com'] && pushed['maya-cal@group.calendar.google.com'].size === 1, JSON.stringify(r.data.sync));
r = await call('POST', '/events?calendar=maya', { 'x-session': mayaNow }, { type: 'BLOCKED', title: 'Kai', start: '2026-09-10T12:00', end: '2026-09-10T13:00', recurrence: null });
ok('and later blocks follow, to hers and not the site one', pushed['maya-cal@group.calendar.google.com'].size === 2 && pushed['ethan-site@group.calendar.google.com'].size === 1);
r = await call('GET', '/settings?calendar=ethan', { 'x-session': ethan });
ok("the first calendar shows the site's Google calendar as its own, from the environment", r.data.google.calendarId === 'ethan-site@group.calendar.google.com' && r.data.google.fromSite === true && r.data.feed.url.endsWith('/api/feed/site-feed-token-0123456789/ethan.ics'), JSON.stringify(r.data.google) + r.data.feed.url);

const ics = async (path) => { const res = await handler(new Request('http://site.test' + path.replace('http://site.test', ''))); return { status: res.status, text: await res.text() }; };
let feed = await ics(mayaFeed);
ok("Maya's feed lists her two sessions under her own title", feed.status === 200 && (feed.text.match(/BEGIN:VEVENT/g) || []).length === 2 && feed.text.includes("X-WR-CALNAME:Maya Chen's Calendar"), feed.text.slice(0, 200));
feed = await ics('/api/feed/site-feed-token-0123456789/tutoring.ics');
ok("the site's own token still opens the first calendar's feed, at its old address", feed.status === 200 && (feed.text.match(/BEGIN:VEVENT/g) || []).length === 1 && feed.text.includes('X-WR-CALNAME:Ethan'), feed.text.slice(0, 200));
feed = await ics('/api/feed/site-feed-token-0123456789/ethan.ics');
ok('and at the new one', feed.status === 200);
feed = await ics(mayaFeed.replace(/\/[A-Za-z0-9_-]+\/maya\.ics$/, '/wrong-token-wrong-token-wrong/maya.ics'));
ok('a wrong token is a plain 404', feed.status === 404);

// ---- more calendars per account, and the master
r = await call('GET', '/me', { 'x-session': mayaNow });
ok('/me lists the account\'s calendars: one so far, the primary', r.data.calendars.length === 1 && r.data.calendars[0].slug === 'maya' && r.data.calendars[0].primary === true && r.data.account.calendarCount === 1, JSON.stringify(r.data.calendars));
r = await call('POST', '/calendars', { 'x-session': mayaNow }, { title: "Maya's Piano Lessons" });
ok('a second calendar is made from a name, at an address from it', r.status === 201 && r.data.calendar.slug === 'mayas-piano-lessons' && r.data.calendars.length === 2, JSON.stringify(r.data));
r = await call('GET', '/events' + week + '&calendar=mayas-piano-lessons', { 'x-session': mayaNow });
ok('and she is its admin, it is live since her email is confirmed, with her name on it', r.data.mode === 'admin' && r.data.calendar.owned === true && r.data.calendar.live === true && r.data.config.portalTitle === "Maya's Piano Lessons" && r.data.config.tutorName === 'Maya Chen');
r = await call('POST', '/events?calendar=mayas-piano-lessons', { 'x-session': mayaNow }, { type: 'BLOCKED', title: 'Piano - Kai', start: '2026-09-10T15:00', end: '2026-09-10T16:00', recurrence: null });
ok('she can write to it', r.status === 200);
r = await call('GET', '/events' + week + '&calendar=maya&with=mayas-piano-lessons,ethan,nobody', { 'x-session': mayaNow });
ok('asking for overlays brings the other calendar\'s events, with its colors, and not someone else\'s', r.data.overlays && r.data.overlays['mayas-piano-lessons'] && r.data.overlays['mayas-piano-lessons'].events.length === 1
  && r.data.overlays['mayas-piano-lessons'].events[0].title === 'Piano - Kai' && r.data.overlays['mayas-piano-lessons'].colors.blocked && !r.data.overlays.ethan && !r.data.overlays.nobody, JSON.stringify(r.data.overlays));
ok('and the calendar in hand is unchanged by the detour', r.data.config.portalTitle === "Maya Chen's Calendar" && r.data.events.length === 2, JSON.stringify(r.data.config));
r = await call('GET', '/events' + week + '&calendar=maya&with=mayas-piano-lessons');
ok('visitors get no overlays', !r.data.overlays);
r = await call('DELETE', '/calendars/ethan', { 'x-session': mayaNow });
ok("she cannot delete the first calendar", r.status === 400 || r.status === 401);
r = await call('DELETE', '/calendars/mayas-piano-lessons', { 'x-session': mayaNow });
ok('she can delete her second calendar', r.status === 200 && r.data.calendars.length === 1, JSON.stringify(r.data));
r = await call('GET', '/events' + week + '&calendar=mayas-piano-lessons', { 'x-session': mayaNow });
ok('and it is gone', r.status === 404);
r = await call('DELETE', '/calendars/maya', { 'x-session': mayaNow });
ok('but not her last one', r.status === 400 && /only calendar/.test(r.data.error));

// the master: the account behind MASTER_EMAIL
r = await call('GET', '/me', { 'x-session': ethan });
ok('the master account says so', r.data.account.master === true);
r = await call('GET', '/me', { 'x-session': mayaNow });
ok('others do not', r.data.account.master === false);
r = await call('GET', '/events' + week + '&calendar=maya', { 'x-session': ethan });
ok("the master opens anyone's calendar as its admin", r.data.mode === 'admin' && r.data.calendar.owned === true);
r = await call('POST', '/events?calendar=maya', { 'x-session': ethan }, { type: 'BLOCKED', title: 'By the master', start: '2026-09-11T10:00', end: '2026-09-11T11:00', recurrence: null });
ok('and can write there', r.status === 200);
r = await call('GET', '/admin/accounts', { 'x-session': mayaNow });
ok('the account list is for the master only', r.status === 403);
r = await call('GET', '/admin/accounts', { 'x-session': ethan });
ok('the master sees every account with its calendars, itself first', r.status === 200 && r.data.accounts.length >= 4 && r.data.accounts[0].email === 'ethan@example.com' && r.data.accounts[0].master === true
  && r.data.accounts.some((a) => a.email === 'maya@example.com' && a.calendars.length === 1 && a.calendars[0].slug === 'maya'), JSON.stringify(r.data.accounts.map((a) => [a.email, a.calendars.map((c) => c.slug)])));
r = await call('GET', '/events' + week + '&calendar=maya&with=ethan', { 'x-session': ethan });
ok('and can overlay any calendar', r.data.overlays && r.data.overlays.ethan && r.data.overlays.ethan.events.length === 1);
r = await call('GET', '/settings?calendar=maya', { 'x-session': ethan });
ok("another account's calendar never falls back to the site's Google calendar - only its own", r.data.google.calendarId === 'maya-cal@group.calendar.google.com' && r.data.google.fromSite === false && r.data.google.calendarId !== 'ethan-site@group.calendar.google.com');

// the example calendar: whatever sits at /demo, once something does
r = await call('GET', '/site');
ok('the site calls itself MyOpenings whatever Netlify calls it, and with no calendar at /demo points at no example', r.data.name === 'MyOpenings' && r.data.demo === null, JSON.stringify(r.data));
r = await call('PUT', '/settings?calendar=maya', { 'x-session': mayaNow }, { slug: 'demo' });
ok('an address can be demo', r.status === 200 && r.data.slug === 'demo');
r = await call('GET', '/site');
ok('and the site then points the home page at it', r.data.demo === 'demo', JSON.stringify(r.data));

fake.close();
console.log(fails.length ? '\nFAILED:\n  ' + fails.join('\n  ') : `\naccounts: all ${ran} checks passed`);
process.exit(fails.length ? 1 : 0);
