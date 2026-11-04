// Block colors: a hex color on an event, color rules layered on a
// series (one date, one weekday, from a date on) so nothing is split,
// "delete all Mondays" on a multi-day series, and the public schedule
// staying red and green throughout.
// Run: node tests/install-shim.mjs && node tests/colors.test.mjs
process.env.ADMIN_PASSWORD = 't';
const api = await import('../netlify/functions/api.mjs');
const { default: handler, resolveOccurrenceColor, applyColorScope, dropWeekday, normalizeSchedule } = api;

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
  return { status: res.status, data: await res.json() };
};
const weekOf = async (start, end, admin = true) => (await req('GET', `/events?start=${start}&end=${end}`, null, admin)).data.events;
const colorsOn = (events, id) => Object.fromEntries(events.filter(e => (e.masterId || e.id) === id).map(e => [e.start.slice(0, 10), e.color || null]));

// ---- pure rules
const series = { id: 's', type: 'BLOCKED', title: 'Maya', notes: '', start: '2026-09-07T16:00', end: '2026-09-07T17:00',
  recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [1, 3], endType: 'NEVER' } };
ok('no color resolves to null (the type default)', resolveOccurrenceColor(series, '2026-09-07') === null);
let painted = applyColorScope(series, { color: '#1d4ed8', scope: 'all' });
ok('"all" sets the series color and leaves no rules', painted.color === '#1d4ed8' && !painted.recurrence.colorRules);
painted = applyColorScope(painted, { color: '#6d28d9', scope: 'weekday', date: '2026-09-09' });
ok('"all Wednesdays" is one weekday rule', painted.recurrence.colorRules.length === 1 && painted.recurrence.colorRules[0].weekday === 3);
ok('Wednesdays are purple, Mondays still blue', resolveOccurrenceColor(painted, '2026-09-09') === '#6d28d9'
  && resolveOccurrenceColor(painted, '2026-09-16') === '#6d28d9' && resolveOccurrenceColor(painted, '2026-09-14') === '#1d4ed8');
painted = applyColorScope(painted, { color: '#0f766e', scope: 'one', date: '2026-09-16' });
ok('"this event only" paints just that date', resolveOccurrenceColor(painted, '2026-09-16') === '#0f766e'
  && resolveOccurrenceColor(painted, '2026-09-23') === '#6d28d9');
painted = applyColorScope(painted, { color: '#be185d', scope: 'weekday', date: '2026-09-23' });
ok('repainting all Wednesdays also covers the one that was singled out', resolveOccurrenceColor(painted, '2026-09-16') === '#be185d'
  && painted.recurrence.colorRules.length === 1, JSON.stringify(painted.recurrence.colorRules));
painted = applyColorScope(painted, { color: '#c2410c', scope: 'following', date: '2026-09-21' });
ok('"this and following" wins over an earlier weekday rule from that date on', resolveOccurrenceColor(painted, '2026-09-23') === '#c2410c'
  && resolveOccurrenceColor(painted, '2026-09-21') === '#c2410c' && resolveOccurrenceColor(painted, '2026-09-16') === '#be185d'
  && resolveOccurrenceColor(painted, '2026-09-14') === '#1d4ed8');
painted = applyColorScope(painted, { color: null, scope: 'one', date: '2026-09-28' });
ok('a rule may restore the default for one block', resolveOccurrenceColor(painted, '2026-09-28') === null
  && resolveOccurrenceColor(painted, '2026-09-30') === '#c2410c');
painted = applyColorScope(painted, { color: '#a16207', scope: 'following', date: '2026-09-07' });
ok('"following" from the first block is the whole series', painted.color === '#a16207' && !painted.recurrence.colorRules);
const single = { ...series, recurrence: { ...series.recurrence, weekdays: [1] } };
painted = applyColorScope(single, { color: '#1d4ed8', scope: 'weekday', date: '2026-09-07' });
ok('"all Mondays" on a Mondays-only series is the whole series', painted.color === '#1d4ed8' && !painted.recurrence.colorRules);
const lone = { ...series, recurrence: null };
painted = applyColorScope(lone, { color: '#1d4ed8', scope: 'one', date: '2026-09-07' });
ok('a standalone takes the color whatever the scope', painted.color === '#1d4ed8' && painted.recurrence === null);

// ---- dropping a weekday
let dropped = dropWeekday({ ...series, recurrence: { ...series.recurrence, exdates: ['2026-09-14', '2026-09-16'],
  colorRules: [{ weekday: 1, color: '#1d4ed8' }, { date: '2026-09-21', color: '#6d28d9' }, { from: '2026-10-01', color: '#0f766e' }] } }, 1);
ok('the weekday leaves the series with its skips and color rules', dropped.recurrence.weekdays.join() === '3'
  && dropped.recurrence.exdates.join() === '2026-09-16' && dropped.recurrence.colorRules.length === 1 && dropped.recurrence.colorRules[0].from);
dropped = dropWeekday({ ...series, recurrence: { ...series.recurrence, endType: 'COUNT', count: 6 } }, 1);
// six blocks: 9/7 9/9 9/14 9/16 9/21 9/23 - the last is Wed 9/23
ok('a counted series is pinned to its current last date first', dropped.recurrence.endType === 'ON' && dropped.recurrence.until === '2026-09-23'
  && dropped.recurrence.count === undefined, JSON.stringify(dropped.recurrence));
let threw = null;
try { dropWeekday(single, 1); } catch (e) { threw = e; }
ok('the only weekday cannot be dropped', threw && /only day/.test(threw.message));
threw = null;
try { dropWeekday(series, 5); } catch (e) { threw = e; }
ok('a weekday the series does not meet on is refused', threw);

// ---- normalising keeps colors
let out = normalizeSchedule([{ ...series, color: '#1d4ed8', recurrence: { ...series.recurrence, endType: 'ON', until: '2026-09-09',
  exdates: ['2026-09-07'], colorRules: [{ weekday: 3, color: '#6d28d9' }] } }]);
ok('a series collapsing to one block gives it that block\'s resolved color', out[0].recurrence === null && out[0].color === '#6d28d9');
const base = { ...series, color: '#1d4ed8', recurrence: { ...series.recurrence, endType: 'ON', until: '2026-09-30' } };
out = normalizeSchedule([base, { id: 'x', type: 'BLOCKED', title: 'Maya', notes: '', start: '2026-09-16T16:00', end: '2026-09-16T17:00',
  color: '#0f766e', recurrence: null }], { absorbInto: 's' });
ok('a standalone with its own color joins a series as a one-date rule', out.length === 1
  && resolveOccurrenceColor(out[0], '2026-09-16') === '#0f766e' && resolveOccurrenceColor(out[0], '2026-09-23') === '#1d4ed8', JSON.stringify(out));
out = normalizeSchedule([base, { id: 'y', type: 'BLOCKED', title: 'Maya', notes: '', start: '2026-09-16T16:00', end: '2026-09-16T17:00',
  color: '#1d4ed8', recurrence: null }], { absorbInto: 's' });
ok('one whose color already matches leaves no rule behind', out.length === 1 && !out[0].recurrence.colorRules);

// ---- through the API
let r = await req('POST', '/events', { type: 'BLOCKED', title: 'Maya', start: '2026-09-07T16:00', end: '2026-09-07T17:00', color: '#1D4ED8',
  recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [1, 3], endType: 'NEVER' } });
ok('a save accepts a hex color', r.status === 200, JSON.stringify(r.data));
const id = r.data.id;
let week = await weekOf('2026-09-13', '2026-09-19');
ok('every block of the week carries the resolved color, lower-cased, with the series color beside it',
  week.length === 2 && week.every(e => e.color === '#1d4ed8' && e.seriesColor === '#1d4ed8'), JSON.stringify(week.map(e => [e.color, e.seriesColor])));
r = await req('POST', '/events', { type: 'BLOCKED', title: 'Plain', start: '2026-09-08T16:00', end: '2026-09-08T17:00', color: '#b42318', recurrence: null });
week = await weekOf('2026-09-06', '2026-09-12');
ok('painting a blocked block the default red stores no colour', r.status === 200 && !week.find(e => e.title === 'Plain').color);
r = await req('POST', `/events/${id}/color`, { color: '#B42318', scope: 'all' });
week = await weekOf('2026-09-13', '2026-09-19');
ok('and so does the colour route', r.status === 200 && week.every(e => (e.masterId || e.id) !== id || (!e.color && e.seriesColor === null)), JSON.stringify(colorsOn(week, id)));
r = await req('POST', `/events/${id}/color`, { color: '#1d4ed8', scope: 'all' });
r = await req('POST', '/events', { type: 'BLOCKED', title: 'Bad', start: '2026-09-08T16:00', end: '2026-09-08T17:00', color: 'red', recurrence: null });
ok('a color that is not hex is refused', r.status === 400);
r = await req('POST', `/events/${id}/color`, { color: '#6d28d9', scope: 'weekday', date: '2026-09-16' });
ok('the color route paints all Wednesdays', r.status === 200 && r.data.ok, JSON.stringify(r.data));
week = await weekOf('2026-09-13', '2026-09-19');
ok('and the week shows blue Monday, purple Wednesday', JSON.stringify(colorsOn(week, id)) === JSON.stringify({ '2026-09-14': '#1d4ed8', '2026-09-16': '#6d28d9' }), JSON.stringify(colorsOn(week, id)));
r = await req('POST', `/events/${id}/color`, { color: '#0f766e', scope: 'one', date: '2026-09-15' });
ok('a date the series misses is refused', r.status === 400);
r = await req('POST', '/events', { id, type: 'BLOCKED', title: 'Maya', notes: '', start: '2026-09-07T16:00', end: '2026-09-07T17:30',
  recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [1, 3], endType: 'NEVER' } });
week = await weekOf('2026-09-13', '2026-09-19');
ok('a re-save that says nothing about color keeps the color and the rules',
  JSON.stringify(colorsOn(week, id)) === JSON.stringify({ '2026-09-14': '#1d4ed8', '2026-09-16': '#6d28d9' }) && week[0].end.endsWith('17:30'), JSON.stringify(colorsOn(week, id)));
r = await req('POST', '/events', { id, type: 'BLOCKED', title: 'Maya', notes: '', start: '2026-09-07T16:00', end: '2026-09-07T17:30', color: '#be185d',
  recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [1, 3], endType: 'NEVER' } });
week = await weekOf('2026-09-13', '2026-09-19');
ok('a re-save with a new color repaints the whole series and drops the rules',
  JSON.stringify(colorsOn(week, id)) === JSON.stringify({ '2026-09-14': '#be185d', '2026-09-16': '#be185d' }), JSON.stringify(colorsOn(week, id)));
r = await req('POST', '/events', { id, type: 'BLOCKED', title: 'Maya', notes: '', start: '2026-09-07T16:00', end: '2026-09-07T17:30', color: null,
  recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [1, 3], endType: 'NEVER' } });
week = await weekOf('2026-09-13', '2026-09-19');
ok('null clears it back to the default', week.every(e => !e.color && e.seriesColor === null));

// ---- custom presets follow the admin
let presets = (await req('GET', '/events?start=2026-09-13&end=2026-09-19')).data.customColors;
ok('palette and default colours never become presets', Array.isArray(presets) && presets.length === 0, JSON.stringify(presets));
await req('POST', '/events', { type: 'BLOCKED', title: 'Custom', start: '2026-09-10T10:00', end: '2026-09-10T11:00', color: '#FF8800', recurrence: null });
await req('POST', `/events/${id}/color`, { color: '#38bdf8', scope: 'one', date: '2026-09-16' });
presets = (await req('GET', '/events?start=2026-09-13&end=2026-09-19')).data.customColors;
ok('a custom color from a save or the color route is a preset, in the order first used', JSON.stringify(presets) === JSON.stringify(['#ff8800', '#38bdf8']), JSON.stringify(presets));
await req('POST', `/events/${id}/color`, { color: '#ff8800', scope: 'one', date: '2026-09-14' });
presets = (await req('GET', '/events?start=2026-09-13&end=2026-09-19')).data.customColors;
ok('using one again neither repeats nor moves it', JSON.stringify(presets) === JSON.stringify(['#ff8800', '#38bdf8']), JSON.stringify(presets));
for (let i = 0; i < 17; i++) await req('POST', `/events/${id}/color`, { color: '#1000' + String(10 + i), scope: 'all' });
presets = (await req('GET', '/events?start=2026-09-13&end=2026-09-19')).data.customColors;
ok('the list keeps the sixteen most recent, oldest dropping off the left', presets.length === 16 && presets[15] === '#100026' && presets[0] === '#100011', JSON.stringify(presets));
r = await req('DELETE', '/customcolors/%23100026');
presets = (await req('GET', '/events?start=2026-09-13&end=2026-09-19')).data.customColors;
ok('a preset can be forgotten', r.status === 200 && presets.length === 15 && !presets.includes('#100026'), JSON.stringify(presets));
r = await req('DELETE', '/customcolors/%23100017', null, false);
ok('but not by the public', r.status === 401);
await req('POST', `/events/${id}/color`, { color: '#1d4ed8', scope: 'all' });

const pub = (await req('GET', '/events?start=2026-09-13&end=2026-09-19', null, false)).data;
ok('the public schedule carries no color at all, presets included - only the two defaults in the config',
  pub.mode === 'public' && !JSON.stringify(pub.events).includes('olor') && !('customColors' in pub) && pub.config.colors.blocked === '#b42318');

r = await req('POST', `/events/${id}/weekday`, { weekday: 1 });
ok('the weekday route drops all Mondays', r.status === 200 && r.data.ok, JSON.stringify(r.data));
week = await weekOf('2026-09-13', '2026-09-19');
ok('leaving only the Wednesdays', week.length === 1 && week[0].start.startsWith('2026-09-16'));
r = await req('POST', `/events/${id}/weekday`, { weekday: 3 });
ok('the last weekday is refused with a pointer to deleting the series', r.status === 400 && /delete the series/.test(r.data.error), JSON.stringify(r.data));
r = await req('POST', `/events/${id}/color`, { color: '#1d4ed8', scope: 'all' }, false);
ok('neither route is open to the public', r.status === 401);

console.log(fails.length ? '\nFAILED:\n  ' + fails.join('\n  ') : `\ncolors: all ${ran} checks passed`);
process.exit(fails.length ? 1 : 0);
