const prism = require('./netserver');

const app = prism();

// ── Global middleware ─────────────────────────
app.use(prism.logger());
app.use(prism.cors());

// ── Static files ──────────────────────────────
app.use('/static', './public');

// ── In-memory "database" ──────────────────────
let users = [
  { id: 1, name: 'Ido',   email: 'ido@example.com' },
  { id: 2, name: 'Tamar',     email: 'tamar@example.com'   },
];
let nextId = 3;

// ── Routes ────────────────────────────────────

app.get('/', (req, res) => {
  res.redirect('/static/index.html');
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/users', (req, res) => {
  const { search } = req.query;
  const result = search
    ? users.filter(u => u.name.toLowerCase().includes(search.toLowerCase()))
    : users;
  res.json(result);
});

app.get('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === parseInt(req.params.id));
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.post('/api/users', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  const user = { id: nextId++, name, email };
  users.push(user);
  res.status(201).json(user);
});

app.put('/api/users/:id', (req, res) => {
  const idx = users.findIndex(u => u.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users[idx] = { ...users[idx], ...req.body, id: users[idx].id };
  res.json(users[idx]);
});

app.delete('/api/users/:id', (req, res) => {
  const idx = users.findIndex(u => u.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  const [removed] = users.splice(idx, 1);
  res.json({ deleted: true, user: removed });
});

// ── Start ─────────────────────────────────────
app.listen(3000, (port) => {
  console.log(`\n  NetServer server running → http://localhost:${port}\n`);
});
