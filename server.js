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
   FIREBASE ADMIN SETUP — Direct JSON file read
   (No .env needed for Firebase)
   ═══════════════════════════════════════════════ */
let db = null;
try {
  const jsonPath = path.join(
    __dirname,
    'sarkresume-firebase-adminsdk-fbsvc-e121c3edde.json'
  );

  if (!fs.existsSync(jsonPath)) {
    throw new Error(
      'Firebase JSON not found. Please place it in sarkresume-api/ folder'
    );
  }

  const serviceAccount = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

  // Fix private key newlines (agar JSON me \n string hai)
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
    throw new Error('Razorpay keys missing in .env');
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
   HEALTH CHECK
   ═══════════════════════════════════════════════ */
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SarkResume API',
    firebase: db ? 'connected' : 'error',
    razorpay: razorpay ? 'connected' : 'error',
    timestamp: new Date().toISOString(),
  });
});

/* ═══════════════════════════════════════════════
   1. CREATE RAZORPAY ORDER
   POST /api/create-order
   Body: { userId }
   ═══════════════════════════════════════════════ */
app.post('/api/create-order', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    if (!razorpay) {
      return res.status(500).json({ error: 'Razorpay not initialized' });
    }

    const order = await razorpay.orders.create({
      amount: 9900, // ₹99 in paise
      currency: 'INR',
      receipt: `order_${userId}_${Date.now()}`,
      notes: {
        userId: userId,
        purpose: 'SarkResume Pro Upgrade',
      },
    });

    console.log('✅ Order created:', order.id, 'for user:', userId);

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
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

    // ═══ Update user in RTDB (admin bypass) ═══
    await db.ref(`users/${userId}`).update({
      plan: 'paid',
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      paidAt: Date.now(),
      updatedAt: Date.now(),
    });

    console.log(`✅ User ${userId} upgraded to PRO`);

    res.json({
      success: true,
      message: 'Payment verified, plan upgraded',
      paymentId: razorpay_payment_id,
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
});
