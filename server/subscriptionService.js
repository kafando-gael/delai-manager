import {config} from './config.js';
import {getPaymentStatus} from './sunrisePayClient.js';
import {
  addOneYear,
  getPaymentRecord,
  getSubscription,
  isSubscriptionActive,
  markPaymentCompleted,
  saveSubscription,
} from './subscriptionStore.js';

function checkoutUrlFor(paymentId, storedUrl) {
  if (storedUrl) {
    return storedUrl;
  }
  return `${config.sunrisePayUrl}/pay/${encodeURIComponent(paymentId)}`;
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

export async function resumePendingPayment(deviceId, pendingPaymentId) {
  const paymentRecord = await getPaymentRecord(pendingPaymentId);
  if (!paymentRecord || paymentRecord.deviceId !== deviceId) {
    return null;
  }

  if (paymentRecord.status === 'completed') {
    await activateSubscription(deviceId, pendingPaymentId);
    const error = new Error('Paiement deja complete');
    error.code = 'PAYMENT_ALREADY_COMPLETED';
    throw error;
  }

  if (paymentRecord.status === 'failed' || paymentRecord.status === 'cancelled') {
    return null;
  }

  return {
    paymentUrl: checkoutUrlFor(pendingPaymentId, paymentRecord.paymentUrl),
    paymentId: pendingPaymentId,
    amount: config.annualFcfa,
    reused: true,
  };
}
