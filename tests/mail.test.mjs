// Request notifications: a new session request emails the address in
// the settings through Brevo; a missing setup or a failed send never
// fails the request; the admin can send a test; the failure is
// remembered for the banner and cleared by the next success.
// Run: node tests/install-shim.mjs && node tests/mail.test.mjs
import { createServer } from 'node:http';
process.env.ADMIN_PASSWORD = 't';
delete process.env.BREVO_API_KEY;
delete process.env.NOTIFY_FROM_EMAIL;
const { mailConfigured, requestNotification, describeWhen } = await import('../netlify/functions/mail.mjs');
const { default: handler } = await import('../netlify/functions/api.mjs');

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
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const request = (over = {}) => ({ name: 'Maya Chen', email: 'Maya.Chen@Example.com', phone: '(555) 555-1234', guardian: 'Lin Chen', subject: 'Algebra II', format: 'Online', start: `${nextWeek}T16:00`, end: `${nextWeek}T17:00`, ...over });

// ---- a fake Brevo
const received = [];
let mode = 'ok';
const fake = createServer((r, res) => {
  let raw = '';
  r.on('data', (c) => raw += c);
  r.on('end', () => {
    received.push({ path: r.url, key: r.headers['api-key'], body: JSON.parse(raw || '{}') });
    if (mode === 'fail') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'unauthorized', message: 'Key not found' })); return; }
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ messageId: '<abc@brevo>' }));
  });
});
await new Promise((r) => fake.listen(0, r));
const base = `http://127.0.0.1:${fake.address().port}`;

// ---- the message itself
const note = requestNotification({ request: request({ recurrence: { frequency: 'WEEKLY', interval: 1, weekdays: [2, 4], endType: 'COUNT', count: 6 } }),
  config: { portalTitle: "Ethan's Tutoring Availability", labels: { person: 'student' } }, siteUrl: 'https://ethan-tutoring.netlify.app/' });
ok('the subject names the requester and the time', /^New session request from Maya Chen - /.test(note.subject) && note.subject.includes('4:00 PM - 5:00 PM'), note.subject);
ok('the text carries name, subject, format, when, repeats and the link', ['Maya Chen', 'Algebra II', 'Online', '4:00 PM - 5:00 PM', 'weekly on Tue, Thu, 6 times', 'https://ethan-tutoring.netlify.app/']
  .every((piece) => note.text.includes(piece)), note.text);
ok('the html escapes what the requester typed', requestNotification({ request: request({ name: '<b>x</b>' }), config: {} }).html.includes('&lt;b&gt;x&lt;/b&gt;'));
ok('the day reads with its weekday', /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4}, /.test(describeWhen(request())), describeWhen(request()));

// ---- not configured: the request still lands
ok('mail is off without the environment', !mailConfigured());
let r = await req('POST', '/requests', request(), false);
ok('a request is accepted with mail off', r.status === 201, JSON.stringify(r.data));
ok('and nothing was sent', received.length === 0);
r = await req('GET', '/events?start=2026-09-13&end=2026-09-19');
ok('the admin load reports mail as not configured', r.data.mail && r.data.mail.configured === false && r.data.mail.address === '', JSON.stringify(r.data.mail));
r = await req('POST', '/settings/testmail');
ok('a test send explains what is missing', r.status === 400 && /BREVO_API_KEY/.test(r.data.error), JSON.stringify(r.data));

// ---- configured, but no address yet
process.env.BREVO_API_KEY = 'xkeysib-test';
process.env.NOTIFY_FROM_EMAIL = 'ethan@example.com';
process.env.BREVO_API_BASE = base;
r = await req('POST', '/requests', request(), false);
ok('with no notification address nothing is sent', r.status === 201 && received.length === 0);
r = await req('POST', '/settings/testmail');
ok('and a test asks for one', r.status === 400 && /notification email/.test(r.data.error), JSON.stringify(r.data));

// ---- the address is set: a request emails it
await req('PUT', '/settings', { notificationEmail: 'ethan@example.com', title: "Ethan's Tutoring Availability" });
r = await req('POST', '/requests', request(), false);
ok('the request is accepted', r.status === 201);
ok('one email went to Brevo with the key, from the verified sender, to the notification address', received.length === 1
  && received[0].path === '/smtp/email' && received[0].key === 'xkeysib-test'
  && received[0].body.sender.email === 'ethan@example.com' && received[0].body.sender.name === "Ethan's Tutoring Availability"
  && received[0].body.to[0].email === 'ethan@example.com', JSON.stringify(received[0]));
ok('with the request in it and the site link', received[0].body.textContent.includes('Maya Chen') && received[0].body.textContent.includes('http://localhost/'), received[0].body.textContent);
ok('the contact details are in it and replies go to the requester', received[0].body.textContent.includes('Guardian: Lin Chen')
  && received[0].body.textContent.includes('maya.chen@example.com') && received[0].body.textContent.includes('(555) 555-1234')
  && received[0].body.replyTo.email === 'maya.chen@example.com' && received[0].body.htmlContent.includes('mailto:maya.chen@example.com'), JSON.stringify(received[0].body.replyTo));
let listed = (await req('GET', '/requests')).data.requests;
ok('the stored request carries the contact, email lower-cased', listed.at(-1).email === 'maya.chen@example.com' && listed.at(-1).phone === '(555) 555-1234' && listed.at(-1).guardian === 'Lin Chen');
r = await req('POST', '/requests', request({ email: 'not-an-email' }), false);
ok('a request without a usable email is refused', r.status === 400 && /email/.test(r.data.error), JSON.stringify(r.data));
r = await req('POST', '/requests', request({ phone: 'call me' }), false);
ok('and so is a phone number that is not one', r.status === 400 && /phone/.test(r.data.error), JSON.stringify(r.data));
r = await req('POST', '/requests', request({ phone: '', guardian: '' }), false);
ok('phone and guardian are optional', r.status === 201);
listed = (await req('GET', '/requests')).data.requests;
ok('and absent when not given', !('phone' in listed.at(-1)) && !('guardian' in listed.at(-1)));
r = await req('GET', '/events?start=2026-09-13&end=2026-09-19');
ok('the admin load shows mail configured with no error', r.data.mail.configured && r.data.mail.address === 'ethan@example.com' && r.data.mail.lastError === null);
const pub = await req('GET', '/events?start=2026-09-13&end=2026-09-19', null, false);
ok('the public load says nothing about mail', !('mail' in pub.data));

// ---- a failure never fails the request, and is remembered
mode = 'fail';
r = await req('POST', '/requests', request({ name: 'Noah' }), false);
ok('a request still lands when Brevo refuses', r.status === 201 && received.length === 3);
r = await req('GET', '/events?start=2026-09-13&end=2026-09-19');
ok('the failure is remembered for the banner', r.data.mail.lastError && /Brevo 401/.test(r.data.mail.lastError.message), JSON.stringify(r.data.mail));
r = await req('POST', '/settings/testmail');
ok('a failing test send reports the reason', r.status === 502 && /Brevo 401/.test(r.data.error), JSON.stringify(r.data));

// ---- a success clears it
mode = 'ok';
r = await req('POST', '/settings/testmail');
ok('a test send succeeds and names the address', r.status === 200 && r.data.ok && r.data.to === 'ethan@example.com', JSON.stringify(r.data));
ok('the test email is a sample request, marked as a test, for next Tuesday at four',
  received.at(-1).body.subject.startsWith("[Test] New session request from John Doe - Tue, ") && received.at(-1).body.subject.includes('4:00 PM - 5:00 PM')
  && received.at(-1).body.textContent.includes('Jane Doe') && received.at(-1).body.textContent.includes('john.doe@example.com')
  && received.at(-1).body.replyTo.email === 'john.doe@example.com', received.at(-1).body.subject);
r = await req('GET', '/events?start=2026-09-13&end=2026-09-19');
ok('and the remembered failure is gone', r.data.mail.lastError === null);
r = await req('POST', '/settings/testmail', null, false);
ok('the public cannot send tests', r.status === 401);

fake.close();
console.log(fails.length ? '\nFAILED:\n  ' + fails.join('\n  ') : `\nmail: all ${ran} checks passed`);
process.exit(fails.length ? 1 : 0);
