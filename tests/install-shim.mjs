// Installs in-memory shims of @netlify/blobs and @netlify/functions into
// node_modules, so the real api.mjs can be imported by the unit tests with
// no npm install and no Netlify credentials. Idempotent; refuses to touch
// real installed packages.
//
//   node tests/install-shim.mjs

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MARKER = '0.0.0-local-shim';

function install(name, source) {
    const dir = join(process.cwd(), 'node_modules', ...name.split('/'));
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
        const existing = JSON.parse(readFileSync(pkg, 'utf8'));
        if (existing.version !== MARKER) {
            console.log(`Real ${name} is installed; leaving it alone.`);
            return;
        }
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(pkg, JSON.stringify({
        name, version: MARKER, type: 'module', main: 'index.js'
    }, null, 2));
    writeFileSync(join(dir, 'index.js'), source);
    console.log(`Shim installed: ${name}`);
}

install('@netlify/blobs', `// Test-only in-memory shim.
const stores = new Map();
export function getStore(options) {
  const name = typeof options === 'string' ? options : options.name;
  if (!stores.has(name)) stores.set(name, new Map());
  const data = stores.get(name);
  return {
    async get(key, opts) {
      if (!data.has(key)) return null;
      const raw = data.get(key);
      return opts && opts.type === 'json' ? JSON.parse(raw) : raw;
    },
    async setJSON(key, value) { data.set(key, JSON.stringify(value)); },
    async delete(key) { data.delete(key); },
    async list(opts) {
      const prefix = (opts && opts.prefix) || '';
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    }
  };
}
`);

install('@netlify/functions', `export async function purgeCache() {}
`);
