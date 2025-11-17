const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// Optional: Twilio for SMS (install with: npm install twilio)
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  const twilio = require('twilio');
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

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
app.use(express.urlencoded({ extended: true })); // for form posts

// Serve HTML files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Simple broker accounts (in-memory for now)
// plan: "tracking" = GPS only, "tms" = GPS + TMS tools
const BROKER_USERS = [
  {
    email: 'broker@test.com',
    password: 'password123', // demo only
    plan: 'tracking'
  },
  {
    email: 'tms@test.com',
    password: 'password123', // demo only
    plan: 'tms'
  }
];

// Simple in-memory "database"
let loads = [];          // { id, reference, driverName, driverPhone, tractorNumber, trailerNumber, equipmentType, pickupAddress, deliveryAddress, rate, notes, sessionToken, status }
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
  const {
    reference,
    driverName,
    driverPhone,
    tractorNumber,
    trailerNumber,
    equipmentType,
    pickupAddress,
    deliveryAddress,
    rate,
    notes
  } = req.body;

  if (!reference || !driverPhone) {
    return res
      .status(400)
      .json({ error: 'reference and driverPhone are required' });
  }

  const sessionToken = makeToken();
  const newLoad = {
    id: loads.length + 1,
    reference,
    driverName: driverName || '',
    driverPhone,
    tractorNumber: tractorNumber || '',
    trailerNumber: trailerNumber || '',
    equipmentType: equipmentType || '',
    pickupAddress: pickupAddress || '',
    deliveryAddress: deliveryAddress || '',
    rate: rate || '',
    notes: notes || '',
    sessionToken,
    status: 'invited' // invited -> tracking -> completed
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

// Optional: send driver link by SMS via Twilio
app.post('/api/loads/:id/send-link', async (req, res) => {
  if (!twilioClient) {
    return res
      .status(500)
      .json({ error: 'Twilio not configured on server (check env vars)' });
  }

  const id = parseInt(req.params.id, 10);
  const load = loads.find(l => l.id === id);

  if (!load) {
    return res.status(404).json({ error: 'Load not found' });
  }

  if (!load.driverPhone) {
    return res.status(400).json({ error: 'No driver phone on this load' });
  }

  const baseUrl = getBaseUrl(req);
  const driverLink = `${baseUrl}/driver.html?s=${load.sessionToken}`;

  try {
    await twilioClient.messages.create({
      to: load.driverPhone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: `MyFreightTracker: Start tracking your load here: ${driverLink}`
    });

    res.json({ message: 'SMS sent', driverLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

// Broker registration (simple, in-memory)
app.post('/broker-register', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).send('Email and password are required.');
  }

  const existing = BROKER_USERS.find(u => u.email === email);
  if (existing) {
    return res.status(400).send('Account already exists. Try logging in.');
  }

  // New accounts default to tracking-only plan
  BROKER_USERS.push({ email, password, plan: 'tracking' });
  res.send(`
    <h1>Account created</h1>
    <p>You can now <a href="/broker-login.html">log in</a> as ${email}.</p>
  `);
});

// Broker login route
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

  const plan = user.plan || 'tracking';

  // For now, we don't use real sessions; we just redirect with plan info
  res.redirect(`/broker-dashboard.html?plan=${encodeURIComponent(plan)}`);
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
