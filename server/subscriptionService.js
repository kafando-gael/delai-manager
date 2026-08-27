import {config} from './config.js';
import {getPaymentStatus} from './sunrisePayClient.js';
import {
  addOneYear,
  getPaymentRecord,
  getSubscription,
  isSubscriptionActive,
  markPaymentCompleted,
  saveSubscription,
  updatePaymentStatus,
} from './subscriptionStore.js';

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
  const remote = await getPaymentStatus(pendingPaymentId);

  if (remote.status === 'pending' && remote.paymentUrl) {
    return {
      paymentUrl: remote.paymentUrl,
      paymentId: pendingPaymentId,
      amount: config.annualFcfa,
      reused: true,
    };
  }

  if (remote.status === 'completed') {
    await activateSubscription(deviceId, pendingPaymentId, {verifyWithSunrise: true});
    const error = new Error('Paiement deja complete');
    error.code = 'PAYMENT_ALREADY_COMPLETED';
    throw error;
  }

  if (remote.status === 'failed' || remote.status === 'cancelled') {
    await updatePaymentStatus(pendingPaymentId, remote.status);
  }

  return null;
}
