// The HTTP side: one endpoint for ESO's webhook provider, two for probes.
//
//   GET /v1/secret?namespace=<ns>&key=<item title>&property=<field>
//       Authorization: Bearer <BRIDGE_TOKEN>
//   -> 200 {"value": "..."}
//
// The namespace picks the vault (`<prefix><namespace>`). ESO fills it in from
// the ExternalSecret, and the URL template that does so belongs to the
// ClusterSecretStore, which only a cluster admin writes. A namespace can name
// any item it likes; it can only ever reach its own vault.
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { NotFound, NoVault, Aborted } from './pass.mjs';

// A Kubernetes namespace is a DNS label. Anything else is not a namespace,
// and refusing it here keeps odd characters out of the vault name.
const NAMESPACE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
// No item title or field name has a control character in it; refusing them
// also keeps the cache key below unambiguous.
const CONTROL = /\p{Cc}/u;
const MAX_KEY = 256;

/** Compares two strings in constant time, via their hashes so lengths may differ. */
function sameSecret(a, b) {
  const digest = s => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Writes a JSON reply. */
function reply(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** A tiny time-bounded cache for successful reads. */
function createCache(seconds, now) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= seconds * 1000) { entries.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) { if (seconds > 0) entries.set(key, { value, at: now() }); },
  };
}

/**
 * Builds the request handler. Split from `startServer` so the tests can call
 * it on an ephemeral port with a fake Proton client.
 */
export function createHandler({ config, pass, log = console.log, now = Date.now }) {
  const cache = createCache(config.cacheSeconds, now);

  /** Handles GET /v1/secret once the caller is authenticated. */
  async function secret(url, req, res) {
    const namespace = url.searchParams.get('namespace') ?? '';
    const key = url.searchParams.get('key') ?? '';
    const field = url.searchParams.get('property') || config.defaultField;
    if (!NAMESPACE.test(namespace)) return reply(res, 400, { error: 'namespace is not a valid Kubernetes namespace' });
    if (!key || key.length > MAX_KEY || CONTROL.test(key)) return reply(res, 400, { error: `key must be 1 to ${MAX_KEY} printable characters` });
    if (field.length > MAX_KEY || CONTROL.test(field)) return reply(res, 400, { error: `property must be at most ${MAX_KEY} printable characters` });

    const vault = `${config.vaultPrefix}${namespace}`;
    const cacheKey = `${vault}\0${key}\0${field}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return reply(res, 200, { value: cached });

    // ESO gives up after its own timeout; a request it abandoned should not
    // keep its place in the queue in front of the ones it sends next.
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableFinished) gone.abort(); });
    try {
      const value = await pass.read(vault, key, field, { signal: gone.signal });
      cache.set(cacheKey, value);
      return reply(res, 200, { value });
    } catch (err) {
      if (err instanceof Aborted) return undefined;
      // 404 makes ESO apply the ExternalSecret's deletionPolicy, so it is
      // kept for "this item or field does not exist" and nothing else.
      if (err instanceof NotFound) return reply(res, 404, { error: err.message });
      if (err instanceof NoVault) return reply(res, 403, { error: `no readable vault "${vault}" for namespace "${namespace}"` });
      log(`error reading ${vault}: ${err.message}`);
      return reply(res, 502, { error: 'Proton Pass did not answer; see the bridge log' });
    }
  }

  /** Routes one request. Everything that can throw is inside `handle`'s try. */
  function route(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/healthz') return reply(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/readyz') {
      return pass.ready ? reply(res, 200, { ok: true }) : reply(res, 503, { error: 'not logged in to Proton Pass' });
    }
    // 400, not 404, for an unknown path: ESO reads a 404 as "the secret was
    // deleted", and a mistyped store URL must not delete anything.
    if (url.pathname !== '/v1/secret') return reply(res, 400, { error: 'no such endpoint' });
    if (req.method !== 'GET') return reply(res, 405, { error: 'GET only' });
    const auth = req.headers.authorization ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!given || !sameSecret(given, config.token)) return reply(res, 401, { error: 'missing or wrong bearer token' });
    return secret(url, req, res);
  }

  return async function handle(req, res) {
    const started = now();
    let status = 0;
    const original = res.writeHead.bind(res);
    res.writeHead = (code, ...rest) => { status = code; return original(code, ...rest); };
    let url;
    try {
      url = new URL(req.url, 'http://bridge');
    } catch {
      return reply(res, 400, { error: 'not a request target' });
    }
    try {
      return await route(req, res, url);
    } catch (err) {
      log(`error on ${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
      return undefined;
    } finally {
      // Names only, never values: the log line says what was asked for and
      // how it went, which is everything a person debugging it needs.
      if (url.pathname === '/v1/secret') {
        const q = url.searchParams;
        log(`${req.method} ${url.pathname} namespace=${JSON.stringify(q.get('namespace'))} key=${JSON.stringify(q.get('key'))} property=${JSON.stringify(q.get('property'))} -> ${status || 'gone'} ${now() - started}ms`);
      }
    }
  };
}

/** Starts listening. Resolves with the server once the port is bound. */
export function startServer(deps) {
  const handle = createHandler(deps);
  const log = deps.log ?? console.log;
  const server = createServer((req, res) => {
    handle(req, res).catch(err => {
      log(`unhandled: ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.config.port, deps.config.host, () => resolve(server));
  });
}
