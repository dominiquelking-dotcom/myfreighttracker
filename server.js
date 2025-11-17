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
let loads = [];          // load records
let trackingPoints = []; // GPS history

// TMS data (in-memory for now)
let customers = []; // { id, name, contactName, phone, email, mcNumber, notes, createdAt }
let carriers = [];  // { id, name, mcNumber, phone, email, truckstopId, datId, notes, createdAt }
let documents = []; // { id, type, reference, loadId, customerName, carrierName, notes, createdAt }

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

//
// ---- TMS APIs ----
//

// Customers
app.get('/api/customers', (req, res) => {
  res.json(customers);
});

app.post('/api/customers', (req, res) => {
  const { name, contactName, phone, email, mcNumber, notes } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Customer name is required' });
  }

  const newCustomer = {
    id: customers.length + 1,
    name,
    contactName: contactName || '',
    phone: phone || '',
    email: email || '',
    mcNumber: mcNumber || '',
    notes: notes || '',
    createdAt: new Date().toISOString()
  };

  customers.push(newCustomer);
  res.json(newCustomer);
});

// Carriers
app.get('/api/carriers', (req, res) => {
  res.json(carriers);
});

app.post('/api/carriers', (req, res) => {
  const { name, mcNumber, phone, email, truckstopId, datId, notes } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Carrier name is required' });
  }

  const newCarrier = {
    id: carriers.length + 1,
    name,
    mcNumber: mcNumber || '',
    phone: phone || '',
    email: email || '',
    truckstopId: truckstopId || '',
    datId: datId || '',
    notes: notes || '',
    createdAt: new Date().toISOString()
  };

  carriers.push(newCarrier);
  res.json(newCarrier);
});

// Documents (rate confirmations, BOLs, carrier packets)
app.get('/api/documents', (req, res) => {
  res.json(documents);
});

app.post('/api/documents', (req, res) => {
  const { type, reference, loadId, customerName, carrierName, notes } = req.body;

  if (!type || !reference) {
