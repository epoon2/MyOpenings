// Local test server: serves public/ and runs the REAL API (the same
// handler Netlify runs) against the in-memory storage shim, so the page
// can be driven end to end with no Netlify and no credentials.
//
//   node tests/install-shim.mjs      (once)
//   node tests/server.mjs [port]
//
// Switches:
//   FAKE_GOOGLE=ok|failed   pretend the site has Google credentials; a
//                           fake Google answers every push with that
//                           outcome (the Sync button and notices work)
//   FAKE_MAIL=ok|failed     pretend Brevo is set up; a fake Brevo records
//                           every send (GET /api/sentmail lists them) or
//                           refuses with a 401
//
// The admin password is "t"; any password is accepted for the legacy
// admin login so older suites that type "test" still work.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import crypto from 'node:crypto';

const ROOT = new URL('../public/', import.meta.url).pathname;
// The port comes from the command line, else from the environment (a
// host such as Render assigns one), else 8877.
const PORT = Number(process.argv[2] || process.env.PORT || 8877);
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css',
               '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

const FAKE_GOOGLE = process.env.FAKE_GOOGLE || '';
const FAKE_MAIL = process.env.FAKE_MAIL || 'off';

// ---- fake Google and fake Brevo, one tiny server
const sentMail = [];
const googleStore = new Map();
const fakes = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => raw += c);
  req.on('end', () => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/token') {
      if (FAKE_GOOGLE === 'failed') return send(401, { error: 'invalid key' });
      return send(200, { access_token: 'tok-1', expires_in: 3600 });
    }
    if (url.pathname === '/smtp/email') {
      const body = raw ? JSON.parse(raw) : {};
      if (FAKE_MAIL === 'failed') return send(401, { code: 'unauthorized', message: 'Key not found' });
      sentMail.push({ to: body.to && body.to[0] && body.to[0].email, replyTo: body.replyTo && body.replyTo.email,
        subject: body.subject, text: body.textContent, html: body.htmlContent, sender: body.sender });
      return send(201, { messageId: '<test@brevo>' });
    }
    const m = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return send(404, { error: 'route' });
    if (FAKE_GOOGLE === 'failed') return send(401, { error: 'invalid key' });
    const id = m[2];
    const body = raw ? JSON.parse(raw) : null;
    if (req.method === 'PUT') { if (!googleStore.has(id)) return send(404, {}); googleStore.set(id, body); return send(200, body); }
    if (req.method === 'POST') { googleStore.set(body.id, body); return send(200, body); }
    if (req.method === 'DELETE') { googleStore.delete(id); res.writeHead(204); return res.end(); }
    if (req.method === 'GET') return send(200, { items: [...googleStore.values()] });
    return send(405, {});
  });
});
await new Promise((r) => fakes.listen(0, '127.0.0.1', r));
const FAKE_BASE = `http://127.0.0.1:${fakes.address().port}`;

// ---- the environment the real handler sees
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 't';
if (FAKE_GOOGLE) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'portal@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' })
  });
  process.env.GOOGLE_CALENDAR_ID = 'tutoring@group.calendar.google.com';
  process.env.GOOGLE_API_BASE = FAKE_BASE;
  process.env.GOOGLE_TOKEN_URL = `${FAKE_BASE}/token`;
} else {
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_CALENDAR_ID;
}
if (FAKE_MAIL !== 'off') {
  process.env.BREVO_API_KEY = 'xkeysib-test';
  process.env.NOTIFY_FROM_EMAIL = 'site@example.com';
  process.env.BREVO_API_BASE = FAKE_BASE;
} else {
  delete process.env.BREVO_API_KEY;
  delete process.env.NOTIFY_FROM_EMAIL;
}

const { default: handler } = await import('../netlify/functions/api.mjs');

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const route = url.pathname.slice(4);
    if (route === '/sentmail') return json(res, 200, { sentMail });
    if (route === '/googlestore') return json(res, 200, { events: [...googleStore.values()] });
    // a readiness probe some suites use
    if (route === '/config') {
      const probe = await handler(new Request(`http://localhost:${PORT}/api/events?start=2026-01-04&end=2026-01-10`));
      return json(res, 200, { config: (await probe.json()).config });
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    // the legacy admin login accepts any password here, as the old stub did
    if (headers.get('x-admin-password')) headers.set('x-admin-password', process.env.ADMIN_PASSWORD);
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body
    });
    let response;
    try {
      response = await handler(request);
    } catch (error) {
      console.error(error);
      return json(res, 500, { error: error.message });
    }
    const out = {};
    response.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  // static; a single-segment path with no file behind it is a calendar
  // address and gets calendar.html, as the Netlify redirect does
  let path = url.pathname === '/' ? '/index.html' : url.pathname === '/dashboard' ? '/dashboard.html' : url.pathname;
  let file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  try {
    await readFile(file);
  } catch {
    if (/^\/[a-z0-9-]+$/i.test(path)) file = join(ROOT, 'calendar.html');
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, () => console.log(`test server on ${PORT}`));
