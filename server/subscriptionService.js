import {config} from './config.js';
import {getPaymentStatus} from './sunrisePayClient.js';
import {
  addOneYear,
  getLatestPaymentForDevice,
  getPaymentRecord,
  getSubscription,
  isSubscriptionActive,
  markPaymentCompleted,
  saveSubscription,
  updatePaymentUrl,
} from './subscriptionStore.js';

function checkoutPayload(paymentId, paymentUrl) {
  return {
    paymentUrl,
    paymentId,
    amount: config.annualFcfa,
    reused: true,
  };
}

export async function reuseExistingCheckout(deviceId) {
  const latest = await getLatestPaymentForDevice(deviceId);
  if (!latest || latest.status === 'completed') {
    return null;
  }

  if (latest.paymentUrl) {
    return checkoutPayload(latest.sunrisePaymentId, latest.paymentUrl);
  }

  const remote = await getPaymentStatus(latest.sunrisePaymentId);
  if (remote.status === 'completed') {
    await activateSubscription(deviceId, latest.sunrisePaymentId);
    const error = new Error('Paiement deja complete');
    error.code = 'PAYMENT_ALREADY_COMPLETED';
    throw error;
  }

  const paymentUrl = remote.paymentUrl || null;
  if (paymentUrl) {
    await updatePaymentUrl(latest.sunrisePaymentId, paymentUrl);
    return checkoutPayload(latest.sunrisePaymentId, paymentUrl);
  }

  const waitError = new Error('Paiement temporairement indisponible. Reessaie dans un instant.');
  waitError.code = 'SUNRISE_TIMEOUT';
  waitError.status = 503;
  throw waitError;
}

export async function activateSubscription(deviceId, paymentId, {verifyWithSunrise = false} = {}) {
  const current = await getSubscription(deviceId);
  const paymentRecord = await getPaymentRecord(paymentId);

  if (!paymentRecord) {
    throw new Error('Paiement introuvable');
  }
  if (paymentRecord.deviceId !== deviceId) {
    throw new Error('Paiement invalide pour cet appareil');
  }

  if (current?.lastPaymentId === paymentId && isSubscriptionActive(current)) {
    if (paymentRecord.status !== 'completed') {
      await markPaymentCompleted(paymentId);
    }
    return current;
  }

  if (paymentRecord.status === 'completed' && current?.lastPaymentId === paymentId) {
    return current;
  }

  if (verifyWithSunrise) {
    const remote = await getPaymentStatus(paymentId);
    if (remote.status !== 'completed') {
      const error = new Error('Paiement non confirme');
      error.status = remote.status;
      throw error;
    }
  }

  const baseDate = current?.endsAt && isSubscriptionActive(current)
    ? new Date(current.endsAt)
    : new Date();

  await markPaymentCompleted(paymentId);

  return saveSubscription(deviceId, {
    status: 'active',
    planCode: 'annual',
    amountPaid: config.annualFcfa,
    startsAt: current?.startsAt && isSubscriptionActive(current) ? current.startsAt : new Date().toISOString(),
    endsAt: addOneYear(baseDate),
    pendingPaymentId: null,
    lastPaymentId: paymentId,
  });
}
