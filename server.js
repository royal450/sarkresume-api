require('dotenv').config();

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));

/* ═══════════════════════════════════════════════
   FIREBASE ADMIN SETUP
   ═══════════════════════════════════════════════ */
let db = null;
try {
  let serviceAccount = null;

  const secretPath = '/etc/secrets/firebase-service-account.json';
  if (fs.existsSync(secretPath)) {
    serviceAccount = JSON.parse(fs.readFileSync(secretPath, 'utf8'));
    console.log('📁 Firebase loaded from Render secret file');
  }

  if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('🌍 Firebase loaded from env var');
  }

  if (!serviceAccount) {
    const localPath = path.join(
      __dirname,
      'sarkresume-firebase-adminsdk-fbsvc-46a8ab394c.json'
    );
    if (fs.existsSync(localPath)) {
      serviceAccount = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      console.log('💻 Firebase loaded from local file');
    }
  }

  if (!serviceAccount) {
    throw new Error('Firebase credentials not found anywhere');
  }

  if (
    serviceAccount.private_key &&
    serviceAccount.private_key.includes('\\n')
  ) {
    serviceAccount.private_key = serviceAccount.private_key.replace(
      /\\n/g,
      '\n'
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://sarkresume-default-rtdb.firebaseio.com',
  });

  db = admin.database();
  console.log('✅ Firebase Admin initialized');
} catch (err) {
  console.error('❌ Firebase init failed:', err.message);
}

/* ═══════════════════════════════════════════════
   RAZORPAY SETUP
   ═══════════════════════════════════════════════ */
let razorpay = null;
try {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay keys missing in environment variables');
  }

  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log('✅ Razorpay initialized');
} catch (err) {
  console.error('❌ Razorpay init failed:', err.message);
}

/* ═══════════════════════════════════════════════
   PRICING CONFIG
   ═══════════════════════════════════════════════ */
const PRICING = {
  INR: {
    amount: 19900,        // ₹199 in paise
    display: '₹199',
    symbol: '₹',
  },
  USD: {
    amount: 240,          // $2.40 in cents
    display: '$2.40',
    symbol: '$',
  },
};

/* ═══════════════════════════════════════════════
   HELPER: Detect user country from IP
   Priority: 1) req.body.country  2) IP geolocation  3) Default INR
   ═══════════════════════════════════════════════ */
async function detectCountry(req, bodyCountry) {
  // 1. Frontend se country aayi hai? Trust it (simple)
  if (bodyCountry && typeof bodyCountry === 'string') {
    return bodyCountry.toUpperCase();
  }

  // 2. IP se detect karo
  try {
    // Get real IP (behind proxy)
    let ip =
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      req.socket.remoteAddress ||
      '';

    // Localhost / private IP → default to India
    if (
      !ip ||
      ip === '::1' ||
      ip.startsWith('127.') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('10.') ||
      ip.startsWith('::ffff:127.')
    ) {
      return 'IN';
    }

    // Remove IPv6 prefix
    if (ip.startsWith('::ffff:')) {
      ip = ip.substring(7);
    }

    // Use free IP geolocation API (no key needed)
    const response = await fetch(`https://ipapi.co/${ip}/country/`, {
      headers: { 'User-Agent': 'SarkResume/1.0' },
    });

    if (!response.ok) {
      console.warn('⚠️ IP lookup failed, defaulting to IN');
      return 'IN';
    }

    const country = (await response.text()).trim().toUpperCase();
    return country || 'IN';
  } catch (err) {
    console.warn('⚠️ Country detection error:', err.message);
    return 'IN';
  }
}

/* ═══════════════════════════════════════════════
   HELPER: Get currency for country
   ═══════════════════════════════════════════════ */
function getCurrencyForCountry(country) {
  // India → INR
  if (country === 'IN') return 'INR';

  // All other countries → USD (PayPal supports)
  return 'USD';
}

/* ═══════════════════════════════════════════════
   HEALTH CHECK
   ═══════════════════════════════════════════════ */
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SarkResume API',
    firebase: db ? 'connected' : 'error',
    razorpay: razorpay ? 'connected' : 'error',
    pricing: PRICING,
    timestamp: new Date().toISOString(),
  });
});

/* ═══════════════════════════════════════════════
   1. CREATE RAZORPAY ORDER (Currency auto-detect)
   POST /api/create-order
   Body: { userId, country? }
   ═══════════════════════════════════════════════ */
app.post('/api/create-order', async (req, res) => {
  try {
    const { userId, country: bodyCountry } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    if (!razorpay) {
      return res.status(500).json({ error: 'Razorpay not initialized' });
    }

    // ═══ Detect country & currency ═══
    const country = await detectCountry(req, bodyCountry);
    const currency = getCurrencyForCountry(country);
    const pricing = PRICING[currency];

    console.log(`🌍 User ${userId} | Country: ${country} | Currency: ${currency}`);

    // ═══ Create order ═══
    const order = await razorpay.orders.create({
      amount: pricing.amount,
      currency: currency,
      receipt: `order_${userId}_${Date.now()}`,
      notes: {
        userId: userId,
        purpose: 'SarkResume Pro Upgrade',
        country: country,
      },
    });

    console.log(
      `✅ Order created: ${order.id} | ${currency} ${pricing.amount}`
    );

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      country: country,
      displayAmount: pricing.display,
    });
  } catch (err) {
    console.error('❌ Order error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════
   2. VERIFY RAZORPAY PAYMENT
   POST /api/verify-payment
   Body: { razorpay_payment_id, razorpay_order_id, razorpay_signature, userId }
   ═══════════════════════════════════════════════ */
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      userId,
    } = req.body;

    if (
      !razorpay_payment_id ||
      !razorpay_order_id ||
      !razorpay_signature ||
      !userId
    ) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!razorpay || !db) {
      return res.status(500).json({ error: 'Services not initialized' });
    }

    // ═══ Verify signature ═══
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.error('❌ Invalid signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // ═══ Fetch payment to confirm captured ═══
    const payment = await razorpay.payments.fetch(razorpay_payment_id);

    if (payment.status !== 'captured' && payment.status !== 'authorized') {
      return res.status(400).json({ error: 'Payment not successful' });
    }

    // ═══ Update user in RTDB ═══
    await db.ref(`users/${userId}`).update({
      plan: 'paid',
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      paidCurrency: payment.currency,
      paidAmount: payment.amount,
      paidAt: Date.now(),
      updatedAt: Date.now(),
    });

    console.log(
      `✅ User ${userId} upgraded to PRO | ${payment.currency} ${payment.amount}`
    );

    res.json({
      success: true,
      message: 'Payment verified, plan upgraded',
      paymentId: razorpay_payment_id,
      currency: payment.currency,
      amount: payment.amount,
    });
  } catch (err) {
    console.error('❌ Verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ═══════════════════════════════════════════════
   START SERVER
   ═══════════════════════════════════════════════ */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 http://localhost:${PORT}`);
  console.log(`💰 INR: ₹199 | USD: $2.40 (auto-detect)`);
});
