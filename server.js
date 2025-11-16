const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Render will set PORT for us. Locally we use 3000.
const PORT = process.env.PORT || 3000;

// Utility for dynamic URLs (Render / localhost)
function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

// Middlewares
app.use(cors());
app.use(express.json());

// ✔ NEW: Needed for POST form fields (broker login)
app.use(express.urlencoded({ extended: true }));

// Serve HTML files from /public
app.use(express.static(path.join(__dirname, 'public')));

// ✔ NEW: Simple broker account (for now)
const BROKER_USERS = [
  {
    email: 'broker@test.com',
    password: 'password123' // demo only
  }
];

// Simple in-memory "database"
let loads = [];          // { id, reference, driverPhone, sessionToken, status }
let trackingPoints = []; // { sessionToken, lat, lng, recordedAt }

// Generate random token for driver tracking
function makeToken(length = 24) {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < length; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

// API home route
app.get('/api', (req, res) => {
  res.json({ message: 'MyFreightTracker API is running' });
});

// Broker creates a new load
app.post('/api/loads', (req, res) => {
  const { reference, driverPhone } = req.body;

  if (!reference || !driverPhone) {
    return res
      .status(400)
      .json({ error: 'reference and driverPhone are required' });
  }

  const sessionToken = makeToken();
  const newLoad = {
    id: loads.length + 1,
    reference,
    driverPhone,
    sessionToken,
    status: 'invited'
  };

  loads.push(newLoad);

  const baseUrl = getBaseUrl(req);
  const driverLink = `${baseUrl}/driver.html?s=${sessionToken}`;

  res.json({
    message: 'Load created',
    load: newLoad,
    driverLink
  });
});

// Broker views all loads with last known location
app.get('/api/loads', (req, res) => {
  const result = loads.map(load => {
    const points = trackingPoints.filter(
      p => p.sessionToken === load.sessionToken
    );
    const lastPoint = points[points.length - 1] || null;

    return {
      ...load,
      lastLocation: lastPoint
        ? {
            lat: lastPoint.lat,
            lng: lastPoint.lng,
            recordedAt: lastPoint.recordedAt
          }
        : null
    };
  });

  res.json(result);
});

// Drivers send GPS updates here
app.post('/api/ping', (req, res) => {
  const { token, lat, lng } = req.body;

  if (!token || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'token, lat, lng are required' });
  }

  const load = loads.find(l => l.sessionToken === token);
  if (!load) {
    return res.status(404).json({ error: 'Invalid session token' });
  }

  load.status = 'tracking';

  trackingPoints.push({
    sessionToken: token,
    lat,
    lng,
    recordedAt: new Date().toISOString()
  });

  res.json({ ok: true });
});

// Manually mark a load complete
app.post('/api/loads/:id/complete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const load = loads.find(l => l.id === id);

  if (!load) {
    return res.status(404).json({ error: 'Load not found' });
  }

  load.status = 'completed';
  res.json({ message: 'Load marked as completed', load });
});

// ✔ NEW: Broker login route
app.post('/broker-login', (req, res) => {
  const { email, password } = req.body;

  const user = BROKER_USERS.find(
    (u) => u.email === email && u.password === password
  );

  if (!user) {
    return res.status(401).send(`
      <h1>Login failed</h1>
      <p>Invalid email or password.</p>
      <p><a href="/broker-login.html">Back to login</a></p>
    `);
  }

  // ✔ NEW: Redirect to real dashboard page
  res.redirect('/broker-dashboard.html');
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

