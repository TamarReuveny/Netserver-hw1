# ⬡ netserver

A creative, minimal HTTP/1.1 framework built on Node.js's low-level `net` module — no `http`, no third-party libraries.

## Design Philosophy

netserver exposes an Express-like API while staying as small as possible. The core ideas:

- **Chainable** — `res.status(201).json(data)` reads like a sentence
- **Middleware-first** — global and per-route stacks run in order, just like Express
- **Batteries included** — `netserver.cors()`, `netserver.logger()`, and static file serving ship out of the box
- **No magic** — every layer (TCP → HTTP parsing → routing → response) is visible and readable

## Usage

```js
const netserver = require('./netserver');
const app = netserver();

// Global middleware
app.use(netserver.logger());
app.use(netserver.cors());

// Static files — two ways
app.use('./public');                  // serve from root
app.use('/static', './public');       // serve under a prefix

// Routes
app.get('/api/users', (req, res) => {
  res.json([{ id: 1, name: 'Alice' }]);
});

app.get('/api/users/:id', (req, res) => {
  res.json({ id: req.params.id });
});

app.post('/api/users', (req, res) => {
  const { name, email } = req.body;   // JSON parsed automatically
  res.status(201).json({ name, email });
});

app.listen(3000, (port) => {
  console.log(`Listening on http://localhost:${port}`);
});
```

## Running the demo

```bash
node server.js
# → open http://localhost:3000
```

## API Reference

### `netserver()`
Returns an `app` instance.

### `app.get / post / put / patch / delete(pattern, ...handlers)`
Register route handlers. `pattern` supports `:param` segments.

```js
app.get('/users/:id/posts/:postId', (req, res) => {
  const { id, postId } = req.params;
});
```

### `app.use([prefix], ...middleware)`
Register global middleware. When called with a string prefix and a path, registers a static file handler.

### `app.static(urlPrefix, dir)` / `app.static(dir)`
Returns a middleware function that serves files from `dir`.

### `app.listen(port, callback)`
Starts the TCP server and returns the `net.Server` instance.

---

### Request object (`req`)

| Property | Description |
|---|---|
| `req.method` | `'GET'`, `'POST'`, etc. |
| `req.path` | URL path (without query string) |
| `req.query` | Parsed query string as object |
| `req.params` | Route parameters (`:id` → `req.params.id`) |
| `req.headers` | Lowercased header map |
| `req.body` | Auto-parsed JSON or form-urlencoded body |

### Response object (`res`)

| Method | Description |
|---|---|
| `res.status(code)` | Set status code (chainable) |
| `res.set(key, value)` | Set a response header (chainable) |
| `res.json(data)` | Send JSON response |
| `res.send(text)` | Send plain text |
| `res.html(str)` | Send HTML |
| `res.sendFile(path)` | Stream a file with correct MIME type |
| `res.redirect(url)` | 302 redirect (pass status as second arg for 301) |

---

### Built-in middleware

```js
app.use(netserver.logger());       // logs METHOD path — Xms
app.use(netserver.cors('*'));      // CORS headers + OPTIONS preflight
```

---

## Creative Feature: Multi-handler Middleware Chains per Route

Each route accepts any number of handlers, enabling reusable middleware pipelines:

```js
function requireAuth(req, res, next) {
  if (!req.headers['authorization']) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function validate(req, res, next) {
  if (!req.body?.name) return res.status(400).json({ error: 'name required' });
  next();
}

app.post('/api/admin/users', requireAuth, validate, (req, res) => {
  res.status(201).json({ created: req.body.name });
});
```

This works identically to Express — `next()` advances through the chain, and any handler can short-circuit with a response.

---

## Project Structure

```
netserver/
├── netserver.js         ← framework core (~200 lines)
├── server.js        ← demo API server
├── public/
│   └── index.html   ← static demo page
└── README.md
```

## How it works under the hood

```
TCP connection (net.Socket)
  └── Buffer accumulation (handles chunked data + Content-Length)
        └── parseRequest() → { method, path, query, headers, body }
              └── Global middleware stack
                    └── Route match (regex + :params)
                          └── Per-route handler chain
                                └── createResponse(socket) → socket.end()
```

The one non-obvious detail: raw TCP data can arrive in multiple chunks, so the server accumulates a `Buffer` and only processes the request once it has received `Content-Length` bytes of body (or the headers end with no body).
