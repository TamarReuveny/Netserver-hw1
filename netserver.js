const net = require('net');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
//  MIME Types
// ─────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const STATUS = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  500: 'Internal Server Error',
};

// ─────────────────────────────────────────────
//  Request Parser
// ─────────────────────────────────────────────

function parseRequest(buffer) {
  const raw = buffer.toString();
  const separatorIndex = raw.indexOf('\r\n\r\n');
  if (separatorIndex === -1) return null;

  const headerSection = raw.slice(0, separatorIndex);
  const body = raw.slice(separatorIndex + 4);
  const lines = headerSection.split('\r\n');

  const [method, fullPath, version] = lines[0].split(' ');
  const [pathname, queryString] = (fullPath || '/').split('?');

  const query = {};
  if (queryString) {
    for (const param of queryString.split('&')) {
      const eq = param.indexOf('=');
      const key = decodeURIComponent(eq === -1 ? param : param.slice(0, eq));
      const val = decodeURIComponent(eq === -1 ? '' : param.slice(eq + 1));
      query[key] = val;
    }
  }

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(':');
    if (colon > 0) {
      headers[lines[i].slice(0, colon).toLowerCase().trim()] =
        lines[i].slice(colon + 1).trim();
    }
  }

  let parsedBody = body;
  const ct = headers['content-type'] || '';
  if (ct.includes('application/json') && body) {
    try { parsedBody = JSON.parse(body); } catch { parsedBody = body; }
  } else if (ct.includes('application/x-www-form-urlencoded') && body) {
    parsedBody = {};
    for (const pair of body.split('&')) {
      const eq = pair.indexOf('=');
      const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq));
      parsedBody[key] = decodeURIComponent(eq === -1 ? '' : pair.slice(eq + 1));
    }
  }

  return { method, path: pathname, query, headers, body: parsedBody, version, params: {} };
}

// ─────────────────────────────────────────────
//  Response Builder
// ─────────────────────────────────────────────

function createResponse(socket) {
  let code = 200;
  let sent = false;
  const headers = { 'Connection': 'close' };

  const res = {
    status(n) { code = n; return res; },

    set(key, value) { headers[key] = value; return res; },

    send(body = '') {
      if (sent) return;
      sent = true;
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      headers['Content-Length'] = buf.length;
      if (!headers['Content-Type']) headers['Content-Type'] = 'text/plain; charset=utf-8';

      let head = `HTTP/1.1 ${code} ${STATUS[code] || 'Unknown'}\r\n`;
      for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
      head += '\r\n';

      socket.write(head);
      socket.end(buf);
    },

    json(data) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      res.send(JSON.stringify(data));
    },

    html(str) {
      headers['Content-Type'] = 'text/html; charset=utf-8';
      res.send(str);
    },

    redirect(location, statusCode = 302) {
      if (sent) return;
      sent = true;
      headers['Location'] = location;
      const head = `HTTP/1.1 ${statusCode} ${STATUS[statusCode]}\r\n` +
        Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        '\r\n\r\n';
      socket.end(head);
    },

    sendFile(filePath) {
      if (sent) return;
      sent = true;
      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          res.status(404).send('Not Found');
          return;
        }
        headers['Content-Type'] = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        headers['Content-Length'] = stats.size;

        let head = `HTTP/1.1 ${code} ${STATUS[code]}\r\n`;
        for (const [k, v] of Object.entries(headers)) head += `${k}: ${v}\r\n`;
        head += '\r\n';

        socket.write(head);
        fs.createReadStream(filePath).pipe(socket);
      });
    },
  };

  return res;
}

// ─────────────────────────────────────────────
//  Route Matcher
// ─────────────────────────────────────────────

function compileRoute(pattern) {
  const paramNames = [];
  const regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '.*' : `\\${c}`))
    .replace(/:([^/]+)/g, (_, name) => { paramNames.push(name); return '([^/]+)'; });
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

// ─────────────────────────────────────────────
//  Prism Core
// ─────────────────────────────────────────────

function createPrism() {
  const routes = {};     // { METHOD: [{ regex, paramNames, handlers[] }] }
  const middleware = []; // global middleware stack

  // ── Routing helpers ──────────────────────────

  function addRoute(method, pattern, ...handlers) {
    if (!routes[method]) routes[method] = [];
    const { regex, paramNames } = compileRoute(pattern);
    routes[method].push({ regex, paramNames, handlers });
  }

  function matchRoute(method, pathname) {
    const bucket = routes[method] || [];
    for (const route of bucket) {
      const m = pathname.match(route.regex);
      if (m) {
        const params = {};
        route.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
        return { handlers: route.handlers, params };
      }
    }
    return null;
  }

  // ── Static file serving ──────────────────────

  function serveStatic(urlPrefix, staticDir) {
    // Normalize: serveStatic('./public') or serveStatic('/assets', './public')
    if (staticDir === undefined) {
      staticDir = urlPrefix;
      urlPrefix = '';
    }
    const resolvedDir = path.resolve(staticDir);

    return function staticMiddleware(req, res, next) {
      if (!req.path.startsWith(urlPrefix === '' ? '/' : urlPrefix)) return next();

      const relativePath = urlPrefix
        ? req.path.slice(urlPrefix.length) || '/'
        : req.path;

      const filePath = path.resolve(path.join(resolvedDir, relativePath));

      // Directory traversal guard
      if (!filePath.startsWith(resolvedDir)) {
        return res.status(403).send('Forbidden');
      }

      fs.stat(filePath, (err, stats) => {
        if (err) return next();

        // Auto-serve index.html for directories
        if (stats.isDirectory()) {
          const indexPath = path.join(filePath, 'index.html');
          return fs.stat(indexPath, (e, s) => {
            if (e || !s.isFile()) return next();
            res.sendFile(indexPath);
          });
        }

        if (!stats.isFile()) return next();
        res.sendFile(filePath);
      });
    };
  }

  // ── Middleware runner ────────────────────────

  function runStack(stack, req, res, finalFn) {
    let i = 0;
    function next(err) {
      if (err) return res.status(500).send('Internal Server Error');
      if (i >= stack.length) return finalFn();
      const fn = stack[i++];
      try { fn(req, res, next); } catch (e) { next(e); }
    }
    next();
  }

  // ── Request dispatcher ───────────────────────

  function dispatch(req, res) {
    runStack(middleware, req, res, () => {
      const matched = matchRoute(req.method, req.path);
      if (!matched) {
        // Check if path exists under a different method (405)
        const anyMethod = Object.keys(routes).find(m => matchRoute(m, req.path));
        if (anyMethod) return res.status(405).json({ error: 'Method Not Allowed' });
        return res.status(404).json({ error: 'Not Found', path: req.path });
      }

      req.params = matched.params;
      runStack(matched.handlers, req, res, () => {});
    });
  }

  // ── Public API ───────────────────────────────

  const app = {
    // HTTP method shortcuts
    get:    (pattern, ...handlers) => { addRoute('GET',    pattern, ...handlers); return app; },
    post:   (pattern, ...handlers) => { addRoute('POST',   pattern, ...handlers); return app; },
    put:    (pattern, ...handlers) => { addRoute('PUT',    pattern, ...handlers); return app; },
    patch:  (pattern, ...handlers) => { addRoute('PATCH',  pattern, ...handlers); return app; },
    delete: (pattern, ...handlers) => { addRoute('DELETE', pattern, ...handlers); return app; },

    // Register global middleware (or static handler)
    use(...args) {
      if (typeof args[0] === 'string') {
        middleware.push(serveStatic(args[0], args[1]));
      } else {
        for (const fn of args) middleware.push(fn);
      }
      return app;
    },

    // Static file helper exposed directly
    static: serveStatic,

    // Start listening
    listen(port, callback) {
      const server = net.createServer((socket) => {
        let buffer = Buffer.alloc(0);

        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);

          // Wait until we have the full headers + body (if Content-Length present)
          const raw = buffer.toString();
          const headerEnd = raw.indexOf('\r\n\r\n');
          if (headerEnd === -1) return; // headers not complete yet

          const headerSection = raw.slice(0, headerEnd);
          const clMatch = headerSection.match(/content-length:\s*(\d+)/i);
          const contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
          const bodyReceived = buffer.length - (headerEnd + 4);

          if (bodyReceived < contentLength) return; // body not complete yet

          const req = parseRequest(buffer);
          if (!req) return socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');

          const res = createResponse(socket);
          dispatch(req, res);
        });

        socket.on('error', () => {});
      });

      server.listen(port, () => {
        if (callback) callback(port);
      });

      return server;
    },
  };

  return app;
}

// ─────────────────────────────────────────────
//  Bundled Middleware
// ─────────────────────────────────────────────

createPrism.json = () => (req, res, next) => next(); // JSON is parsed automatically
createPrism.cors = (origin = '*') => (req, res, next) => {
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  next();
};
createPrism.logger = () => (req, res, next) => {
  const start = Date.now();
  const originalSend = res.send.bind(res);
  res.send = (...args) => {
    console.log(`  ${req.method.padEnd(7)} ${req.path} — ${Date.now() - start}ms`);
    return originalSend(...args);
  };
  next();
};

module.exports = createPrism;
