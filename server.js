const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();

// ----------------------
//  POSTGRES (db.js)
// ----------------------
const db = require('./db');

//
// ----------------------
//  TWILIO (OPTIONAL)
// ----------------------
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  const twilio = require('twilio');
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

//
// ----------------------
//  EMAIL (Nodemailer)
// ----------------------
let mailTransport = null;
if (
  process.env.SMTP_HOST &&
  process.env.SMTP_PORT &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
) {
  const nodemailer = require('nodemailer');
  mailTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false, // Only true if using port 465
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

//
// ----------------------
//  FMCSA (QCMobile API)
// ----------------------
const FMCSA_BASE_URL = 'https://mobile.fmcsa.dot.gov/qc/services';
const hasFmcsa = !!process.env.FMCSA_WEBKEY;

// Helper to call FMCSA QCMobile API
async function fetchFmcsaCarrier({ dotNumber, docketNumber, name }) {
  if (!hasFmcsa) {
    throw new Error('FMCSA_WEBKEY is not configured');
  }

  let path;

  if (dotNumber) {
    // Lookup by DOT #
    path = `/carriers/${encodeURIComponent(dotNumber)}`;
  } else if (docketNumber) {
    // Lookup by MC/docket #
    path = `/carriers/docket-number/${encodeURIComponent(docketNumber)}/`;
  } else if (name) {
    // Lookup by carrier name (takes first result)
    path = `/carriers/name/${encodeURIComponent(name)}?size=1`;
  } else {
    throw new Error('No identifier provided for FMCSA lookup');
  }

  const webKeyParam = path.includes('?') ? '&' : '?';
  const url = `${FMCSA_BASE_URL}${path}${webKeyParam}webKey=${encodeURIComponent(
    process.env.FMCSA_WEBKEY
  )}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`FMCSA API error: ${resp.status}`);
  }

  const data = await resp.json();

  const first = data && data.content && data.content[0];
  if (!first || !first.carrier) {
    throw new Error('No carrier data found in FMCSA response');
  }

  const carrier = first.carrier;

  return {
    dotNumber: carrier.dotNumber || null,
    mcNumber: carrier.mcNumber || null,
    legalName: carrier.legalName || null,
    dbaName: carrier.dbaName || null,
    allowedToOperate: carrier.allowedToOperate || null, // "Y" / "N"
    outOfServiceDate: carrier.outOfServiceDate || null,
    phyStreet: carrier.phyStreet || null,
    phyCity: carrier.phyCity || null,
    phyState: carrier.phyState || null,
    phyZipcode: carrier.phyZipcode || null,
    telephone: carrier.telephone || null,
    raw: carrier // full raw FMCSA record if you want it
  };
}

//
// ----------------------
//  CREDIT WALLET / PRICING
// ----------------------
//
// Simple global wallet for now (no real auth yet).
//
const WALLET = {
  trackingCredits: 20.0, // e.g. $20 worth of tracking-only
  tmsCredits: 75.0       // e.g. $75 worth of TMS plan funds
};

const PRICING = {
  trackingPerLoad: 2.0,   // $2 per load (tracking-only plan)
  tmsPerLoad: 1.25        // $1.25 per load (TMS plan)
};

//
// ----------------------
//  SERVER CONFIG
// ----------------------
const PORT = process.env.PORT || 3000;

function getBaseUrl(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${req.get('host')}`;
}

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

//
// ----------------------
//  BROKER ACCOUNTS (LEGACY FALLBACK)
// ----------------------
//  NOTE: real accounts are now stored in PostgreSQL (app_users).
//  This array is just so old test users like tms@test.com still work.
const BROKER_USERS = [
  {
    email: 'broker@test.com',
    password: 'password123',
    plan: 'tracking'
  },
  {
    email: 'tms@test.com',
    password: 'password123',
    plan: 'tms'
  }
];

//
// ----------------------
//  IN-MEMORY DATA
// ----------------------
let loads = [];          // load records
let trackingPoints = []; // GPS pings

let customers = [];
let carriers = [];
let documents = [];

function makeToken(length = 24) {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let t = '';
  for (let i = 0; i < length; i++) {
    t += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return t;
}

//
// ----------------------
//  BASIC API
// ----------------------
app.get('/api', (req, res) => {
  res.json({ message: 'MyFreightTracker API is running' });
});

//
// ----------------------
//  SPOT QUOTE / PRICING ENGINE
// ----------------------
app.post('/api/quote', (req, res) => {
  try {
    const {
      origin,
      destination,
      miles,
      equipment,
      weight,
      margin,
      direction,   // 'headhaul' | 'balanced' | 'backhaul'
      urgency,     // 'standard' | 'rush'
      weekend,     // boolean
      fuelPerMile  // number
    } = req.body;

    const dist = Number(miles) || 0;
    const wt = Number(weight) || 0;
    const mg = Number(margin) || 0;
    const fuel = Number(fuelPerMile) || 0;

    if (!origin || !destination || dist <= 0) {
      return res.status(400).json({ error: 'Invalid quote data' });
    }

    // --- Base CPM by equipment type ---
    let baseCpm;
    switch (equipment) {
      case 'reefer':
        baseCpm = 2.85;
        break;
      case 'flatbed':
        baseCpm = 2.45;
        break;
      case 'hotshot':
        baseCpm = 2.15;
        break;
      case 'van':
      default:
        baseCpm = 2.30;
        break;
    }

    // --- Distance band adjustments ---
    if (dist < 150) {
      baseCpm += 0.40; // short-haul premium
    } else if (dist > 750) {
      baseCpm -= 0.15; // long-haul discount
    }

    // --- Weight adjustments (rough heuristic) ---
    if (wt > 42000) {
      baseCpm += 0.12;
    } else if (wt < 15000 && wt > 0) {
      baseCpm -= 0.05;
    }

    // --- Lane direction adjustments ---
    if (direction === 'headhaul') {
      baseCpm += 0.12; // harder trucks
    } else if (direction === 'backhaul') {
      baseCpm -= 0.10; // easier trucks
    }

    // --- Urgency adjustments ---
    if (urgency === 'rush') {
      baseCpm += 0.15;
    }

    // --- Weekend / holiday adjustment ---
    if (weekend) {
      baseCpm += 0.05;
    }

    if (baseCpm < 1.0) baseCpm = 1.0;

    const totalCost = baseCpm * dist;
    const fuelTotal = fuel > 0 ? fuel * dist : 0;

    const costPlusFuel = totalCost + fuelTotal;
    const marginMultiplier = 1 + (mg / 100 || 0);

    const sellRateMarket = costPlusFuel * marginMultiplier;
    const sellRateAggressive = sellRateMarket * 0.97;
    const sellRatePremium = sellRateMarket * 1.05;

    const effectiveMarginMarket =
      ((sellRateMarket - costPlusFuel) / sellRateMarket) * 100;

    res.json({
      origin,
      destination,
      miles: dist,
      equipment,
      weight: wt,
      margin: mg,
      direction: direction || 'balanced',
      urgency: urgency || 'standard',
      weekend: !!weekend,
      fuelPerMile: fuel,
      fuelTotal,
      costPerMile: baseCpm,
      totalCost,
      sellRateAggressive,
      sellRateMarket,
      sellRatePremium,
      effectiveMarginMarket
    });
  } catch (err) {
    console.error('Error in /api/quote:', err);
    res.status(500).json({ error: 'Server error calculating quote' });
  }
});

//
// ----------------------
//  LOAD CREATION (with billing)
// ----------------------
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
    notes,
    plan // 'tracking' or 'tms' from the dashboard
  } = req.body;

  if (!reference || !driverPhone) {
    return res.status(400).json({
      error: 'reference and driverPhone are required'
    });
  }

  const effectivePlan = plan === 'tms' ? 'tms' : 'tracking';
  let costPerLoad, walletKey;

  if (effectivePlan === 'tms') {
    costPerLoad = PRICING.tmsPerLoad;
    walletKey = 'tmsCredits';
  } else {
    costPerLoad = PRICING.trackingPerLoad;
    walletKey = 'trackingCredits';
  }

  const currentCredits = WALLET[walletKey] ?? 0;

  if (currentCredits < costPerLoad) {
    return res.status(402).json({
      error: 'Insufficient credits to create a new load.',
      plan: effectivePlan,
      requiredCredits: costPerLoad,
      currentCredits
    });
  }

  WALLET[walletKey] = currentCredits - costPerLoad;

  const token = makeToken();
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
    sessionToken: token,
    status: 'invited'
  };

  loads.push(newLoad);

  const baseUrl = getBaseUrl(req);
  const driverLink = `${baseUrl}/driver.html?s=${token}`;

  res.json({
    message: 'Load created',
    load: newLoad,
    driverLink,
    billing: {
      plan: effectivePlan,
      debited: costPerLoad,
      remainingCredits: WALLET[walletKey]
    }
  });
});

//
// ----------------------
//  GET LOADS WITH LAST GPS
// ----------------------
app.get('/api/loads', (req, res) => {
  const result = loads.map(load => {
    const points = trackingPoints.filter(
      p => p.sessionToken === load.sessionToken
    );
    const last = points[points.length - 1] || null;

    return {
      ...load,
      lastLocation: last
        ? {
            lat: last.lat,
            lng: last.lng,
            recordedAt: last.recordedAt
          }
        : null
    };
  });

  res.json(result);
});

//
// ----------------------
//  DRIVER GPS PING
// ----------------------
app.post('/api/ping', (req, res) => {
  const { token, lat, lng } = req.body;

  if (!token || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'token, lat, lng are required' });
  }

  const load = loads.find(l => l.sessionToken === token);
  if (!load) return res.status(404).json({ error: 'Invalid session token' });

  load.status = 'tracking';

  trackingPoints.push({
    sessionToken: token,
    lat,
    lng,
    recordedAt: new Date().toISOString()
  });

  res.json({ ok: true });
});

//
// ----------------------
//  COMPLETE A LOAD
// ----------------------
app.post('/api/loads/:id/complete', (req, res) => {
  const id = Number(req.params.id);
  const load = loads.find(l => l.id === id);
  if (!load) return res.status(404).json({ error: 'Load not found' });

  load.status = 'completed';
  res.json({ message: 'Load marked as completed', load });
});

//
// ----------------------
//  SMS DRIVER LINK (Twilio)
// ----------------------
app.post('/api/loads/:id/send-link', async (req, res) => {
  if (!twilioClient) {
    return res.status(500).json({
      error: 'Twilio not configured'
    });
  }

  const id = Number(req.params.id);
  const load = loads.find(l => l.id === id);

  if (!load) return res.status(404).json({ error: 'Load not found' });
  if (!load.driverPhone)
    return res.status(400).json({ error: 'Driver phone missing' });

  const baseUrl = getBaseUrl(req);
  const link = `${baseUrl}/driver.html?s=${load.sessionToken}`;

  try {
    await twilioClient.messages.create({
      to: load.driverPhone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: `MyFreightTracker: Start tracking your load here: ${link}`
    });

    res.json({ message: 'SMS sent', driverLink: link });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Twilio SMS failed' });
  }
});

//
// ======================
//  TMS FEATURES
// ======================
//

// CUSTOMERS
app.get('/api/customers', (req, res) => {
  res.json(customers);
});

app.post('/api/customers', (req, res) => {
  const { name, contactName, phone, email, mcNumber, notes } = req.body;

  if (!name)
    return res.status(400).json({ error: 'Customer name is required' });

  const record = {
    id: customers.length + 1,
    name,
    contactName: contactName || '',
    phone: phone || '',
    email: email || '',
    mcNumber: mcNumber || '',
    notes: notes || '',
    createdAt: new Date().toISOString()
  };

  customers.push(record);
  res.json(record);
});

// CARRIERS
app.get('/api/carriers', (req, res) => {
  res.json(carriers);
});

app.post('/api/carriers', (req, res) => {
  const { name, mcNumber, phone, email, truckstopId, datId, notes } = req.body;

  if (!name)
    return res.status(400).json({ error: 'Carrier name is required' });

  const record = {
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

  carriers.push(record);
  res.json(record);
});

// DOCUMENTS
app.get('/api/documents', (req, res) => {
  res.json(documents);
});

app.post('/api/documents', (req, res) => {
  const { type, reference, loadId, customerName, carrierName, notes } = req.body;

  if (!type || !reference)
    return res.status(400).json({
      error: 'type and reference required'
    });

  const record = {
    id: documents.length + 1,
    type,
    reference,
    loadId: loadId || null,
    customerName: customerName || '',
    carrierName: carrierName || '',
    notes: notes || '',
    createdAt: new Date().toISOString()
  };

  documents.push(record);
  res.json(record);
});

//
// ----------------------
//  EMAIL DOCUMENT TO CARRIER
// ----------------------
app.post('/api/documents/:id/send-to-carrier', async (req, res) => {
  if (!mailTransport) {
    return res.status(500).json({
      error: 'Email not configured (check SMTP env vars)'
    });
  }

  const id = Number(req.params.id);
  const doc = documents.find(d => d.id === id);

  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (!doc.carrierName)
    return res
      .status(400)
      .json({ error: 'carrierName not set on document' });

  const carrier = carriers.find(
    c => c.name.toLowerCase() === doc.carrierName.toLowerCase()
  );

  if (!carrier)
    return res.status(404).json({
      error: `Carrier "${doc.carrierName}" not found`
    });

  if (!carrier.email)
    return res
      .status(400)
      .json({ error: 'Carrier has no email address' });

  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;

  const brokerEmail = 'broker@example.com'; // placeholder until real auth system

  const typeLabel =
    doc.type === 'rate-confirmation'
      ? 'Rate Confirmation'
      : doc.type === 'bol'
      ? 'Bill of Lading'
      : doc.type === 'carrier-packet'
      ? 'Carrier Packet'
      : doc.type;

  const subject = `MyFreightTracker: ${typeLabel} ${doc.reference}`;

  const textBody = `
Hello,

Please find the details for the ${typeLabel.toLowerCase()} below:

Type: ${typeLabel}
Reference: ${doc.reference}
Load ID: ${doc.loadId || '-'}
Customer: ${doc.customerName || '-'}
Carrier: ${doc.carrierName || '-'}

Notes:
${doc.notes || '-'}

This is an automated message from MyFreightTracker.
(No PDF attachment yet — coming soon.)
  `.trim();

  try {
    await mailTransport.sendMail({
      from: fromEmail,
      to: carrier.email,
      replyTo: brokerEmail,
      subject,
      text: textBody
    });

    res.json({
      message: 'Email sent to carrier',
      to: carrier.email,
      subject
    });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

//
// ----------------------
//  BILLING / WALLET INFO
// ----------------------
app.get('/api/billing', (req, res) => {
  res.json({
    wallet: WALLET,
    pricing: PRICING
  });
});

//
// ----------------------
//  FMCSA VERIFY ENDPOINT
// ----------------------
//
//  GET /api/fmcsa/carrier?dot=123456
//  GET /api/fmcsa/carrier?mc=654321
//  GET /api/fmcsa/carrier?name=LEATHERNECK%20TRUCKING
//
app.get('/api/fmcsa/carrier', async (req, res) => {
  if (!hasFmcsa) {
    return res.status(500).json({
      error: 'FMCSA_WEBKEY not configured on server'
    });
  }

  const { dot, mc, name } = req.query;

  if (!dot && !mc && !name) {
    return res.status(400).json({
      error: 'Provide ?dot=, ?mc=, or ?name= query parameter'
    });
  }

  try {
    const result = await fetchFmcsaCarrier({
      dotNumber: dot,
      docketNumber: mc,
      name
    });

    res.json(result);
  } catch (err) {
    console.error('FMCSA lookup error:', err.message || err);
    res.status(500).json({
      error: 'FMCSA lookup failed',
      details: err.message || String(err)
    });
  }
});

//
// ----------------------
//  BROKER REGISTRATION (NOW USING POSTGRES)
// ----------------------
app.post('/broker-register', async (req, res) => {
  const { email, password, companyName } = req.body;

  if (!email || !password) {
    return res.status(400).send('Email and password are required.');
  }

  try {
    // Check if user already exists
    const existing = await db.query(
      'SELECT id FROM app_users WHERE email = $1',
      [email]
    );

    if (existing.rowCount > 0) {
      return res.status(400).send('Account already exists.');
    }

    // Create user in app_users
    const inserted = await db.query(
      `INSERT INTO app_users (role, email, password_plain, full_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ['broker', email, password, null]
    );

    const userId = inserted.rows[0].id;

    // Create basic broker profile
    await db.query(
      `INSERT INTO broker_profiles (user_id, company_name)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, companyName || null]
    );

    // Create a billing account with zero balance
    await db.query(
      `INSERT INTO billing_accounts (user_id, account_type, balance_cents)
       VALUES ($1, 'broker', 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    res.send(`
      <h1>Account created</h1>
      <p>Login at <a href="/broker-login.html">Broker Login</a></p>
    `);
  } catch (err) {
    console.error('Broker register error:', err);
    res.status(500).send('Server error creating account.');
  }
});

//
// ----------------------
//  BROKER LOGIN (DB FIRST, LEGACY FALLBACK)
// ----------------------
app.post('/broker-login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).send(`
      <h1>Login failed</h1>
      <p>Email and password are required.</p>
      <a href="/broker-login.html">Back to login</a>
    `);
  }

  try {
    // Try PostgreSQL first
    const dbUser = await db.query(
      `SELECT id, email, role
         FROM app_users
        WHERE email = $1
          AND password_plain = $2
          AND role = 'broker'
          AND (is_active IS NULL OR is_active = TRUE)
        LIMIT 1`,
      [email, password]
    );

    let plan = 'tracking';

    if (dbUser.rowCount > 0) {
      const user = dbUser.rows[0];

      // Try to pull active subscription to decide plan (optional)
      try {
        const subs = await db.query(
          `SELECT sp.code
             FROM user_subscriptions us
             JOIN subscription_plans sp ON sp.id = us.plan_id
            WHERE us.user_id = $1
              AND us.status IN ('trial','active')
            ORDER BY us.created_at DESC
            LIMIT 1`,
          [user.id]
        );

        if (subs.rowCount > 0) {
          const code = subs.rows[0].code;
          if (code === 'BROKER_TMS') {
            plan = 'tms';
          } else {
            plan = 'tracking';
          }
        }
      } catch (subErr) {
        console.warn('Subscription lookup failed, defaulting plan=tracking');
      }

      // Special override: keep old behavior for tms@test.com
      if (email === 'tms@test.com') {
        plan = 'tms';
      }

      return res.redirect(
        `/broker-dashboard.html?plan=${encodeURIComponent(plan)}`
      );
    }

    // Legacy fallback: in-memory BROKER_USERS array
    const legacyUser = BROKER_USERS.find(
      u => u.email === email && u.password === password
    );

    if (!legacyUser) {
      return res.status(401).send(`
        <h1>Login failed</h1>
        <p>Invalid email or password.</p>
        <a href="/broker-login.html">Back to login</a>
      `);
    }

    plan = legacyUser.plan || 'tracking';

    return res.redirect(
      `/broker-dashboard.html?plan=${encodeURIComponent(plan)}`
    );
  } catch (err) {
    console.error('Broker login error:', err);
    return res.status(500).send(`
      <h1>Login failed</h1>
      <p>Server error. Please try again later.</p>
      <a href="/broker-login.html">Back to login</a>
    `);
  }
});

//
// ----------------------
//  TEST DB ENDPOINT
// ----------------------
app.get('/test-db', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    res.send('Database connected! Time: ' + result.rows[0].now);
  } catch (err) {
    console.error('DB test error:', err);
    res.status(500).send('Database error: ' + (err.message || String(err)));
  }
});

//
// ----------------------
//  START SERVER
// ----------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
