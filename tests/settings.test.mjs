// Settings: title, display name, time zone, hours, default colors,
// wording and the notification address - stored beside the presets,
// validated on the way in, and shaping the config every response
// carries. The public never sees the notification address.
// Run: node tests/install-shim.mjs && node tests/settings.test.mjs
process.env.ADMIN_PASSWORD = 't';
process.env.CALENDAR_FEED_TOKEN = 'feed-token-for-the-test';
process.env.FAKE_GOOGLE = '1';
const api = await import('../netlify/functions/api.mjs');
const { default: handler } = api;

let ran = 0;
const fails = [];
const ok = (name, cond, extra = '') => {
  ran++;
  if (cond) console.log('  ok ' + name);
  else fails.push(name + (extra ? `\n    ${extra}` : ''));
};
const req = async (method, path, body, admin = true) => {
  const res = await handler(new Request('http://localhost/api' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-admin-password': 't' } : {}) },
    body: body ? JSON.stringify(body) : undefined }));
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { text }; }
  return { status: res.status, data, text, headers: res.headers };
};

// ---- defaults
let r = await req('GET', '/settings');
ok('the admin can read the settings', r.status === 200 && r.data.settings.title === "Ethan's Tutoring Availability"
  && r.data.settings.displayName === 'Ethan' && r.data.settings.timezoneId === 'America/Los_Angeles'
  && r.data.settings.dayStart === 8 && r.data.settings.dayEnd === 24, JSON.stringify(r.data.settings));
ok('with the defaults for colours and wording', r.data.settings.colors.available === '#2f7d4a' && r.data.settings.colors.blocked === '#b42318'
  && r.data.settings.labels.blocked === 'Blocked Session' && r.data.settings.labels.people === 'students' && r.data.settings.notificationEmail === '');
ok('the config beside them says Pacific Time (PT)', r.data.config.timezoneLabel === 'Pacific Time (PT)', r.data.config.timezoneLabel);
r = await req('GET', '/settings', null, false);
ok('the public cannot read them', r.status === 401);
r = await req('PUT', '/settings', { title: 'x' }, false);
ok('or write them', r.status === 401);

// ---- changing everything
r = await req('PUT', '/settings', {
  title: "Maya's Piano Lessons", displayName: 'Maya', timezoneId: 'America/New_York', dayStart: 9, dayEnd: 21,
  colors: { available: '#1D4ED8', blocked: '#6d28d9' },
  labels: { available: 'Open', blocked: 'Lesson', person: 'pupil', people: 'pupils' },
  notificationEmail: 'maya@example.com'
});
ok('a full update is accepted', r.status === 200 && r.data.ok, JSON.stringify(r.data));
ok('and the config reflects it, time zone label included', r.data.config.portalTitle === "Maya's Piano Lessons" && r.data.config.tutorName === 'Maya'
  && r.data.config.timezoneId === 'America/New_York' && r.data.config.timezoneLabel === 'Eastern Time (ET)'
  && r.data.config.dayStart === 9 && r.data.config.dayEnd === 21 && r.data.config.colors.available === '#1d4ed8'
  && r.data.config.labels.blocked === 'Lesson', JSON.stringify(r.data.config));
ok('a time zone change re-pushes the booked sessions to Google', r.data.sync && r.data.sync.google, JSON.stringify(r.data.sync));

const pub = (await req('GET', '/events?start=2026-09-13&end=2026-09-19', null, false)).data;
ok('the public page gets the new title, name, hours, colours and wording', pub.config.portalTitle === "Maya's Piano Lessons"
  && pub.config.tutorName === 'Maya' && pub.config.dayStart === 9 && pub.config.colors.blocked === '#6d28d9' && pub.config.labels.people === 'pupils');
ok('but never the notification address', !JSON.stringify(pub).includes('maya@example.com') && !('notificationEmail' in pub.config));

// ---- the defaults follow the settings
r = await req('POST', '/events', { type: 'BLOCKED', title: 'Lesson', start: '2026-09-14T10:00', end: '2026-09-14T11:00', color: '#6d28d9', recurrence: null });
let week = (await req('GET', '/events?start=2026-09-13&end=2026-09-19')).data.events;
ok('painting a block the new default purple stores no colour', !week.find(e => e.title === 'Lesson').color);
r = await req('GET', '/events?start=2026-09-13&end=2026-09-19');
ok('and purple is not offered as a preset', r.data.customColors.length === 0, JSON.stringify(r.data.customColors));

// ---- the feed and Google carry the zone
r = await req('GET', `/feed/${process.env.CALENDAR_FEED_TOKEN}/tutoring.ics`);
ok('the feed names the new zone and writes UTC stamps', r.status === 200 && r.text.includes('X-WR-TIMEZONE:America/New_York')
  && /DTSTART:\d{8}T\d{6}Z/.test(r.text) && !r.text.includes('VTIMEZONE'), r.text.slice(0, 300));

// ---- partial updates and validation
r = await req('PUT', '/settings', { dayStart: 7 });
ok('a partial update keeps the rest', r.status === 200 && r.data.settings.dayStart === 7 && r.data.settings.dayEnd === 21 && r.data.settings.title === "Maya's Piano Lessons");
for (const [body, why] of [
  [{ title: '' }, 'an empty title'],
  [{ title: 'x'.repeat(81) }, 'a title over 80 characters'],
  [{ timezoneId: 'Mars/Olympus' }, 'an unknown time zone'],
  [{ dayStart: 10, dayEnd: 10 }, 'a day that ends when it starts'],
  [{ dayStart: -1 }, 'an hour before midnight'],
  [{ dayEnd: 25 }, 'an hour past midnight'],
  [{ colors: { blocked: 'red' } }, 'a colour that is not hex'],
  [{ labels: { people: '' } }, 'an empty word for people'],
  [{ notificationEmail: 'not-an-email' }, 'a malformed email']
]) {
  r = await req('PUT', '/settings', body);
  ok(`${why} is refused`, r.status === 400, JSON.stringify(r.data));
}
r = await req('PUT', '/settings', { notificationEmail: '' });
ok('the notification address can be cleared', r.status === 200 && r.data.settings.notificationEmail === '');
r = await req('GET', '/settings');
ok('nothing of the refused updates stuck', r.data.settings.dayStart === 7 && r.data.settings.timezoneId === 'America/New_York');

// ---- back to Los Angeles: the feed is local again
await req('PUT', '/settings', { timezoneId: 'America/Los_Angeles' });
r = await req('GET', `/feed/${process.env.CALENDAR_FEED_TOKEN}/tutoring.ics`);
ok('Los Angeles keeps its VTIMEZONE feed', r.text.includes('TZID:America/Los_Angeles') && r.text.includes('DTSTART;TZID=America/Los_Angeles:'));

// ---- looks: week start, clock, typeface
r = await req('PUT', '/settings', { weekStart: 1, hourFormat: '24', font: 'serif' });
ok('week start, clock and typeface are saved and served in the config', r.status === 200 && r.data.config.weekStart === 1 && r.data.config.hourFormat === '24' && r.data.config.font === 'serif', JSON.stringify(r.data.config));
r = await req('PUT', '/settings', { weekStart: 3 });
ok('the week starts on Sunday or Monday only', r.status === 400);
r = await req('PUT', '/settings', { hourFormat: '13' });
ok('the clock is 12 or 24', r.status === 400);
r = await req('PUT', '/settings', { font: 'comic' });
ok('the typeface is one of the choices', r.status === 400);
r = await req('GET', '/events?start=2026-09-06&end=2026-09-12', null, false);
ok('visitors get them too', r.data.config.weekStart === 1 && r.data.config.hourFormat === '24' && r.data.config.font === 'serif');

console.log(fails.length ? '\nFAILED:\n  ' + fails.join('\n  ') : `\nsettings: all ${ran} checks passed`);
process.exit(fails.length ? 1 : 0);
