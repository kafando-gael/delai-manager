import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import {config} from './config.js';
import {errorHandler} from './middleware/errorHandler.js';
import {verifyWebhookSecret} from './middleware/webhookAuth.js';
import {createPayment, getPaymentStatus} from './sunrisePayClient.js';
import {activateSubscription, reuseExistingCheckout} from './subscriptionService.js';
import {
  checkDatabaseConnection,
  clearPendingSubscription,
  createPaymentRecord,
  getSubscription,
  isSubscriptionActive,
  saveSubscription,
  updatePaymentStatus,
  upsertClient,
} from './subscriptionStore.js';

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({limit: '256kb'}));

const corsOptions = config.isProduction && config.corsOrigins.length > 0
  ? {origin: config.corsOrigins}
  : {};
app.use(cors(corsOptions));

const rateLimitJson = error => ({
  statusCode: 429,
  message: {error},
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.isProduction ? 300 : 1000,
  ...rateLimitJson('Trop de requetes. Reessaie dans quelques minutes.'),
});

app.use('/api', apiLimiter);

function publicBaseUrl() {
  if (config.publicApiUrl) {
    return config.publicApiUrl;
  }
  return `http://localhost:${config.port}`;
}

function isValidDeviceId(deviceId) {
  return /^dev_[a-z0-9]+_[a-z0-9]+$/i.test(deviceId);
}

async function buildStatus(deviceId) {
  const subscription = await getSubscription(deviceId);
  const active = isSubscriptionActive(subscription);
  const endsAt = subscription?.endsAt ? new Date(subscription.endsAt) : null;
  const daysLeft = active && endsAt
    ? Math.max(0, Math.ceil((endsAt - new Date()) / (1000 * 60 * 60 * 24)))
    : 0;

  return {
    annualPriceFcfa: config.annualFcfa,
    freeDeadlineLimit: 1,
    isActive: active,
    daysLeft,
    endsAt: subscription?.endsAt || null,
    status: subscription?.status || 'none',
    pendingPaymentId: subscription?.pendingPaymentId || null,
  };
}

app.get('/health', async (_req, res) => {
  try {
    await checkDatabaseConnection();
    return res.json({
      ok: true,
      env: config.nodeEnv,
      db: 'connected',
    });
  } catch (error) {
    console.error('[health]', error.message);
    return res.status(503).json({
      ok: false,
      env: config.nodeEnv,
      db: 'error',
    });
  }
});

app.post('/api/clients/sync', async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    if (!deviceId || !isValidDeviceId(deviceId)) {
      return res.status(400).json({error: 'deviceId invalide'});
    }

    const client = await upsertClient({
      deviceId,
      name: String(req.body.name || '').trim() || null,
      email: String(req.body.email || '').trim() || null,
      phone: String(req.body.phone || '').trim() || null,
      usageReason: String(req.body.usageReason || '').trim() || null,
      ageRange: String(req.body.ageRange || '').trim() || null,
    });

    return res.json({success: true, clientId: client.id});
  } catch (error) {
    console.error('[clients/sync]', error.message);
    return res.status(500).json({error: config.isProduction ? 'Erreur interne' : error.message});
  }
});

app.get('/api/subscription/status', async (req, res) => {
  try {
    const deviceId = String(req.query.deviceId || '').trim();
    if (!deviceId || !isValidDeviceId(deviceId)) {
      return res.status(400).json({error: 'deviceId invalide'});
    }
    return res.json(await buildStatus(deviceId));
  } catch (error) {
    console.error('[subscription/status]', error.message);
    return res.status(500).json({error: config.isProduction ? 'Erreur interne' : error.message});
  }
});

app.post('/api/subscription/pay', async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    const customerEmail = String(req.body.customerEmail || '').trim();
    const customerPhone = String(req.body.customerPhone || '').trim();
    const customerName = String(req.body.customerName || '').trim();
    const usageReason = String(req.body.usageReason || '').trim();
    const ageRange = String(req.body.ageRange || '').trim();

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return res.status(400).json({error: 'deviceId invalide'});
    }
    if (
      !customerEmail
      || !customerEmail.includes('@')
      || customerEmail.endsWith('@delaimanager.local')
      || customerEmail.endsWith('@ontime.local')
    ) {
      return res.status(400).json({error: 'Email valide requis pour le paiement'});
    }

    const current = await getSubscription(deviceId);
    if (isSubscriptionActive(current)) {
      return res.status(400).json({error: 'Abonnement deja actif'});
    }

    try {
      const reused = await reuseExistingCheckout(deviceId);
      if (reused) {
        return res.json(reused);
      }
    } catch (error) {
      if (error.code === 'PAYMENT_ALREADY_COMPLETED') {
        return res.json(await buildStatus(deviceId));
      }
      throw error;
    }

    const client = await upsertClient({
      deviceId,
      name: customerName || 'Utilisateur OnTime',
      email: customerEmail,
      phone: customerPhone || null,
      usageReason: usageReason || null,
      ageRange: ageRange || null,
    });

    const backendUrl = publicBaseUrl();
    const returnUrl = `${config.returnScheme}://payment/return?purpose=subscription&status=success`;
    const cancelUrl = `${config.returnScheme}://payment/return?purpose=subscription&status=cancelled`;

    const payment = await createPayment({
      purpose: 'buyer_access',
      amount: config.annualFcfa,
      userId: deviceId,
      metadata: {
        customerEmail,
        customerPhone: customerPhone || '22600000000',
        customerName: customerName || 'Utilisateur OnTime',
        returnUrl,
        cancelUrl,
      },
      callbackUrl: `${backendUrl}/api/subscription/webhook/${encodeURIComponent(deviceId)}`,
    });

    await createPaymentRecord({
      deviceId,
      clientId: client.id,
      sunrisePaymentId: payment.paymentId,
      amount: config.annualFcfa,
      paymentUrl: payment.paymentUrl,
    });

    await saveSubscription(deviceId, {
      status: 'pending_payment',
      pendingPaymentId: payment.paymentId,
      amountPaid: config.annualFcfa,
    }, client.id);

    return res.json({
      paymentUrl: payment.paymentUrl,
      paymentId: payment.paymentId,
      amount: config.annualFcfa,
    });
  } catch (error) {
    console.error('[subscription/pay]', error.message);
    if (error.code === 'RATE_LIMITED' || error.status === 429) {
      return res.status(429).json({
        error: 'Trop de tentatives de paiement. Reessaie dans quelques minutes.',
      });
    }
    if (error.code === 'SUNRISE_TIMEOUT' || error.status === 503) {
      return res.status(503).json({
        error: 'Paiement temporairement indisponible. Reessaie dans un instant.',
      });
    }
    return res.status(500).json({error: config.isProduction ? 'Erreur interne' : error.message});
  }
});

app.post('/api/subscription/confirm', async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    const paymentId = String(req.body.paymentId || '').trim();

    if (!deviceId || !paymentId || !isValidDeviceId(deviceId)) {
      return res.status(400).json({error: 'deviceId et paymentId requis'});
    }

    await activateSubscription(deviceId, paymentId, {verifyWithSunrise: true});
    return res.json(await buildStatus(deviceId));
  } catch (error) {
    console.error('[subscription/confirm]', error.message);
    if (error.status) {
      return res.status(400).json({
        error: 'Paiement non confirme',
        status: error.status,
      });
    }
    return res.status(500).json({error: config.isProduction ? 'Erreur interne' : error.message});
  }
});

app.post('/api/subscription/cancel', async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    const paymentId = String(req.body.paymentId || '').trim();

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return res.status(400).json({error: 'deviceId requis'});
    }

    if (paymentId) {
      await updatePaymentStatus(paymentId, 'cancelled');
    }

    await clearPendingSubscription(deviceId);
    return res.json(await buildStatus(deviceId));
  } catch (error) {
    console.error('[subscription/cancel]', error.message);
    return res.status(500).json({error: config.isProduction ? 'Erreur interne' : error.message});
  }
});

app.post(
  '/api/subscription/webhook/:deviceId',
  verifyWebhookSecret,
  async (req, res) => {
    try {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const paymentId = String(req.body?.paymentId || req.body?.token || '').trim();
      const status = String(req.body?.status || '').toLowerCase();

      if (!deviceId || !isValidDeviceId(deviceId)) {
        return res.status(400).json({error: 'deviceId invalide'});
      }
      if (!paymentId) {
        return res.status(400).json({error: 'paymentId manquant'});
      }

      if (status === 'completed') {
        if (config.isProduction) {
          const remote = await getPaymentStatus(paymentId);
          if (remote.status !== 'completed') {
            return res.status(400).json({error: 'Statut non confirme par Sunrise Pay'});
          }
        }
        await activateSubscription(deviceId, paymentId);
        return res.json({success: true});
      }

      if (status === 'failed' || status === 'cancelled') {
        await updatePaymentStatus(paymentId, status);
        await clearPendingSubscription(deviceId);
        return res.json({received: true, status});
      }

      return res.json({received: true, ignored: true});
    } catch (error) {
      console.error('[subscription/webhook]', error.message);
      return res.status(500).json({error: config.isProduction ? 'Erreur interne' : error.message});
    }
  },
);

app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`OnTime API (${config.nodeEnv}) on port ${config.port}`);
  if (config.isProduction) {
    console.log(`Public URL: ${config.publicApiUrl}`);
  }
});
