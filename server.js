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
    path = `/carriers/${encodeURIComponent(dotNumber)}`;
  } else if (docketNumber) {
    path = `/carriers/docket-number/${encodeURIComponent(docketNumber)}/`;
  } else if (name) {
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
    allowedToOperate: carrier.allowedToOperate || null,
    outOfServiceDate: carrier.outOfServiceDate || null,
    phyStreet: carrier.phyStreet || null,
    phyCity: carrier.phyCity || null,
    phyState: carrier.phyState || null,
    phyZipcode: carrier.phyZipcode || null,
    telephone: carrier.telephone || null,
    raw: carrier
  };
}

//
// ----------------------
//  CREDIT WALLET / PRICING (still in-memory for now)
// ----------------------
const WALLET = {
  trackingCredits: 20.0,
  tmsCredits: 75.0
};

const PRICING = {
  trackingPerLoad: 2.0,
  tmsPerLoad: 1.25
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
// Real accounts are in app_users (Postgres). This keeps old test users working.
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
      direction,
      urgency,
      weekend,
      fuelPerMile
    } = req.body;

    const dist = Number(miles) || 0;
    const wt = Number(weight) || 0;
    const mg = Number(margin) || 0;
    const fuel = Number(fuelPerMile) || 0;

    if (!origin || !destination || dist <= 0) {
      return res.status(400).json({ error: 'Invalid quote data' });
    }

    // Base CPM by equipment
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

    // Distance band
    if (dist < 150) {
      baseCpm += 0.40;
    } else if (dist > 750) {
      baseCpm -= 0.15;
    }

    // Weight
    if (wt > 42000) {
      baseCpm += 0.12;
    } else if (wt < 15000 && wt > 0) {
      baseCpm -= 0.05;
    }

    // Lane
    if (direction === 'headhaul') {
      baseCpm += 0.12;
    } else if (direction === 'backhaul') {
      baseCpm -= 0.10;
    }

    // Urgency
    if (urgency === 'rush') {
      baseCpm += 0.15;
    }

    // Weekend
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
// ======================================================
//  LOADS + GPS (Postgres-based)
// ======================================================
//

// CREATE LOAD
app.post('/api/loads', async (req, res) => {
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
    plan // 'tracking' or 'tms'
  } = req.body;

  if (!reference || !driverPhone) {
    return res.status(400).json({
      error: 'reference and driverPhone are required'
    });
  }

  const effectivePlan = plan === 'tms' ? 'tms' : 'tracking';
  const walletKey = effectivePlan === 'tms' ? 'tmsCredits' : 'trackingCredits';
  const costPerLoad =
    effectivePlan === 'tms' ? PRICING.tmsPerLoad : PRICING.trackingPerLoad;

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

  try {
    const insert = await db.query(
      `INSERT INTO loads (
         reference_number,
         broker_id,
         equipment_type,
         driver_name,
         driver_phone,
         tractor_number,
         trailer_number,
         pickup_address_short,
         delivery_address_short,
         total_rate,
         commodity_description,
         status,
         session_token
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        reference,
        1, // TEMP: broker_id until we add real auth/session
        equipmentType || '',
        driverName || '',
        driverPhone,
        tractorNumber || '',
        trailerNumber || '',
        pickupAddress || '',
        deliveryAddress || '',
        rate ? Number(rate) : null,
        notes || '',
        'invited',
        token
      ]
    );

    const loadId = insert.rows[0].id;
    const baseUrl = getBaseUrl(req);
    const driverLink = `${baseUrl}/driver.html?s=${token}`;

    res.json({
      message: 'Load created',
      load: {
        id: loadId,
        reference,
        driverName: driverName || '',
        driverPhone,
        tractorNumber: tractorNumber || '',
        trailerNumber: trailerNumber || '',
        equipmentType: equipmentType || '',
        pickupAddress,
        deliveryAddress,
        rate,
        notes,
        status: 'invited',
        sessionToken: token
      },
      driverLink,
      billing: {
        plan: effectivePlan,
        debited: costPerLoad,
        remainingCredits: WALLET[walletKey]
      }
    });
  } catch (err) {
    console.error('Error creating load:', err);
    res.status(500).json({ error: 'Server error creating load' });
  }
});

// GET LOADS + last GPS point
app.get('/api/loads', async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT
        l.id,
        l.reference_number,
        l.driver_name,
        l.driver_phone,
        l.tractor_number,
        l.trailer_number,
        l.equipment_type,
        l.pickup_address_short,
        l.delivery_address_short,
        l.total_rate,
        l.commodity_description AS notes,
        l.status,
        l.session_token,
        gp.latitude,
        gp.longitude,
        gp.recorded_at
      FROM loads l
      LEFT JOIN LATERAL (
        SELECT latitude, longitude, recorded_at
        FROM gps_points
        WHERE load_id = l.id
        ORDER BY recorded_at DESC
        LIMIT 1
      ) gp ON TRUE
      ORDER BY l.id ASC
      `
    );

    const loads = result.rows.map(row => ({
      id: row.id,
      reference: row.reference_number,
      driverName: row.driver_name,
      driverPhone: row.driver_phone,
      tractorNumber: row.tractor_number,
      trailerNumber: row.trailer_number,
      equipmentType: row.equipment_type,
      pickupAddress: row.pickup_address_short,
      deliveryAddress: row.delivery_address_short,
      rate: row.total_rate,
      notes: row.notes,
      status: row.status,
      sessionToken: row.session_token,
      lastLocation: row.latitude
        ? {
            lat: Number(row.latitude),
            lng: Number(row.longitude),
            recordedAt: row.recorded_at
          }
        : null
    }));

    res.json(loads);
  } catch (err) {
    console.error('Error fetching loads:', err);
    res.status(500).json({ error: 'Server error fetching loads' });
  }
});

// DRIVER GPS PING
app.post('/api/ping', async (req, res) => {
  const { token, lat, lng } = req.body;

  if (!token || typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'token, lat, lng are required' });
  }

  try {
    const loadResult = await db.query(
      'SELECT id FROM loads WHERE session_token = $1 LIMIT 1',
      [token]
    );

    if (loadResult.rowCount === 0) {
      return res.status(404).json({ error: 'Invalid session token' });
    }

    const loadId = loadResult.rows[0].id;

    await db.query(
      `INSERT INTO gps_points (trucker_id, load_id, latitude, longitude, recorded_at, source)
       VALUES (NULL, $1, $2, $3, NOW(), 'mobile_app')`,
      [loadId, lat, lng]
    );

    await db.query(
      `UPDATE loads
       SET status = 'tracking', updated_at = NOW()
       WHERE id = $1`,
      [loadId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Error in /api/ping:', err);
    res.status(500).json({ error: 'Server error recording GPS ping' });
  }
});

// COMPLETE LOAD
app.post('/api/loads/:id/complete', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid load id' });

  try {
    const updated = await db.query(
      `UPDATE loads
       SET status = 'completed', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id]
    );

    if (updated.rowCount === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }

    res.json({ message: 'Load marked as completed', load: updated.rows[0] });
  } catch (err) {
    console.error('Error completing load:', err);
    res.status(500).json({ error: 'Server error completing load' });
  }
});

// SMS DRIVER LINK (Twilio)
app.post('/api/loads/:id/send-link', async (req, res) => {
  if (!twilioClient) {
    return res.status(500).json({
      error: 'Twilio not configured'
    });
  }

  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid load id' });

  try {
    const result = await db.query(
      `SELECT driver_phone, session_token
       FROM loads
       WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Load not found' });
    }

    const load = result.rows[0];

    if (!load.driver_phone) {
      return res.status(400).json({ error: 'Driver phone missing' });
    }

    const baseUrl = getBaseUrl(req);
    const link = `${baseUrl}/driver.html?s=${load.session_token}`;

    await twilioClient.messages.create({
      to: load.driver_phone,
      from: process.env.TWILIO_FROM_NUMBER,
      body: `MyFreightTracker: Start tracking your load here: ${link}`
    });

    res.json({ message: 'SMS sent', driverLink: link });
  } catch (err) {
    console.error('Twilio send-link error:', err);
    res.status(500).json({ error: 'Twilio SMS failed' });
  }
});

//
// ======================
//  TMS FEATURES (NOW POSTGRES)
// ======================
//

// CUSTOMERS
app.get('/api/customers', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, contact_name, phone, email, mc_number, notes, created_at
       FROM customers
       ORDER BY id ASC`
    );

    const customers = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      contactName: row.contact_name,
      phone: row.phone,
      email: row.email,
      mcNumber: row.mc_number,
      notes: row.notes,
      createdAt: row.created_at
    }));

    res.json(customers);
  } catch (err) {
    console.error('Error fetching customers:', err);
    res.status(500).json({ error: 'Server error fetching customers' });
  }
});

app.post('/api/customers', async (req, res) => {
  const { name, contactName, phone, email, mcNumber, notes } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Customer name is required' });
  }

  try {
    const insert = await db.query(
      `INSERT INTO customers (
         broker_id,
         name,
         contact_name,
         phone,
         email,
         mc_number,
         notes
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, name, contact_name, phone, email, mc_number, notes, created_at`,
      [
        1, // TEMP: broker_id until auth added
        name,
        contactName || '',
        phone || '',
        email || '',
        mcNumber || '',
        notes || ''
      ]
    );

    const row = insert.rows[0];
    res.json({
      id: row.id,
      name: row.name,
      contactName: row.contact_name,
      phone: row.phone,
      email: row.email,
      mcNumber: row.mc_number,
      notes: row.notes,
      createdAt: row.created_at
    });
  } catch (err) {
    console.error('Error creating customer:', err);
    res.status(500).json({ error: 'Server error creating customer' });
  }
});

// CARRIERS
app.get('/api/carriers', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, mc_number, phone, email, truckstop_id, dat_id, notes, created_at
       FROM carriers
       ORDER BY id ASC`
    );

    const carriers = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      mcNumber: row.mc_number,
      phone: row.phone,
      email: row.email,
      truckstopId: row.truckstop_id,
      datId: row.dat_id,
      notes: row.notes,
      createdAt: row.created_at
    }));

    res.json(carriers);
  } catch (err) {
    console.error('Error fetching carriers:', err);
    res.status(500).json({ error: 'Server error fetching carriers' });
  }
});

app.post('/api/carriers', async (req, res) => {
  const { name, mcNumber, phone, email, truckstopId, datId, notes } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Carrier name is required' });
  }

  try {
    const insert = await db.query(
      `INSERT INTO carriers (
         broker_id,
         name,
         mc_number,
         phone,
         email,
         truckstop_id,
         dat_id,
         notes
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, name, mc_number, phone, email, truckstop_id, dat_id, notes, created_at`,
      [
        1, // TEMP: broker_id until auth added
        name,
        mcNumber || '',
        phone || '',
        email || '',
        truckstopId || '',
        datId || '',
        notes || ''
      ]
    );

    const row = insert.rows[0];
    res.json({
      id: row.id,
      name: row.name,
      mcNumber: row.mc_number,
      phone: row.phone,
      email: row.email,
      truckstopId: row.truckstop_id,
      datId: row.dat_id,
      notes: row.notes,
      createdAt: row.created_at
    });
  } catch (err) {
    console.error('Error creating carrier:', err);
    res.status(500).json({ error: 'Server error creating carrier' });
  }
});

// DOCUMENTS
app.get('/api/documents', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, doc_type, reference, load_id, customer_name, carrier_name, notes, uploaded_at
       FROM documents
       ORDER BY id ASC`
    );

    const docs = result.rows.map(row => ({
      id: row.id,
      type: row.doc_type,
      reference: row.reference,
      loadId: row.load_id,
      customerName: row.customer_name,
      carrierName: row.carrier_name,
      notes: row.notes,
      createdAt: row.uploaded_at
    }));

    res.json(docs);
  } catch (err) {
    console.error('Error fetching documents:', err);
    res.status(500).json({ error: 'Server error fetching documents' });
  }
});

app.post('/api/documents', async (req, res) => {
  const { type, reference, loadId, customerName, carrierName, notes } = req.body;

  if (!type || !reference) {
    return res.status(400).json({
      error: 'type and reference required'
    });
  }

  try {
    const insert = await db.query(
      `INSERT INTO documents (
         load_id,
         uploaded_by,
         doc_type,
         reference,
         customer_name,
         carrier_name,
         notes
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, doc_type, reference, load_id, customer_name, carrier_name, notes, uploaded_at`,
      [
        loadId || null,
        1, // TEMP: uploaded_by broker id
        type,
        reference,
        customerName || '',
        carrierName || '',
        notes || ''
      ]
    );

    const row = insert.rows[0];
    res.json({
      id: row.id,
      type: row.doc_type,
      reference: row.reference,
      loadId: row.load_id,
      customerName: row.customer_name,
      carrierName: row.carrier_name,
      notes: row.notes,
      createdAt: row.uploaded_at
    });
  } catch (err) {
    console.error('Error creating document:', err);
    res.status(500).json({ error: 'Server error creating document' });
  }
});

//
// ----------------------
//  EMAIL DOCUMENT TO CARRIER (from DB)
// ----------------------
app.post('/api/documents/:id/send-to-carrier', async (req, res) => {
  if (!mailTransport) {
    return res.status(500).json({
      error: 'Email not configured (check SMTP env vars)'
    });
  }

  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Invalid document id' });
  }

  try {
    const docResult = await db.query(
      `SELECT id, doc_type, reference, load_id, customer_name, carrier_name, notes
       FROM documents
       WHERE id = $1`,
      [id]
    );

    if (docResult.rowCount === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];

    if (!doc.carrier_name) {
      return res.status(400).json({ error: 'carrierName not set on document' });
    }

    const carrierResult = await db.query(
      `SELECT email
       FROM carriers
       WHERE LOWER(name) = LOWER($1)
       LIMIT 1`,
      [doc.carrier_name]
    );

    if (carrierResult.rowCount === 0) {
      return res.status(404).json({
        error: `Carrier "${doc.carrier_name}" not found`
      });
    }

    const carrierEmail = carrierResult.rows[0].email;
    if (!carrierEmail) {
      return res.status(400).json({ error: 'Carrier has no email address' });
    }

    const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
    const brokerEmail = 'broker@example.com'; // placeholder until real auth

    const typeLabel =
      doc.doc_type === 'rate-confirmation'
        ? 'Rate Confirmation'
        : doc.doc_type === 'bol'
        ? 'Bill of Lading'
        : doc.doc_type === 'carrier-packet'
        ? 'Carrier Packet'
        : doc.doc_type;

    const subject = `MyFreightTracker: ${typeLabel} ${doc.reference || ''}`;

    const textBody = `
Hello,

Please find the details for the ${typeLabel.toLowerCase()} below:

Type: ${typeLabel}
Reference: ${doc.reference || '-'}
Load ID: ${doc.load_id || '-'}
Customer: ${doc.customer_name || '-'}
Carrier: ${doc.carrier_name || '-'}

Notes:
${doc.notes || '-'}

This is an automated message from MyFreightTracker.
(No PDF attachment yet — coming soon.)
    `.trim();

    await mailTransport.sendMail({
      from: fromEmail,
      to: carrierEmail,
      replyTo: brokerEmail,
      subject,
      text: textBody
    });

    res.json({
      message: 'Email sent to carrier',
      to: carrierEmail,
      subject
    });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Failed to send email' });
  }
});

//
// ----------------------
//  BILLING / WALLET INFO (still in-memory)
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
//  BROKER REGISTRATION (Postgres)
// ----------------------
app.post('/broker-register', async (req, res) => {
  const { email, password, companyName } = req.body;

  if (!email || !password) {
    return res.status(400).send('Email and password are required.');
  }

  try {
    const existing = await db.query(
      'SELECT id FROM app_users WHERE email = $1',
      [email]
    );

    if (existing.rowCount > 0) {
      return res.status(400).send('Account already exists.');
    }

    const inserted = await db.query(
      `INSERT INTO app_users (role, email, password_plain, full_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      ['broker', email, password, null]
    );

    const userId = inserted.rows[0].id;

    await db.query(
      `INSERT INTO broker_profiles (user_id, company_name)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, companyName || null]
    );

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
//  BROKER LOGIN (DB-first with legacy fallback)
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

      if (email === 'tms@test.com') {
        plan = 'tms';
      }

      return res.redirect(
        `/broker-dashboard.html?plan=${encodeURIComponent(plan)}`
      );
    }

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
