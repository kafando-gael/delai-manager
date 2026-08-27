import {config} from './config.js';

function headers() {
  return {
    Authorization: `Bearer ${config.sunrisePayApiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function createPayment({ purpose, amount, userId, metadata, callbackUrl }) {
  const response = await fetch(`${config.sunrisePayUrl}/payments`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ purpose, amount, userId, metadata, callbackUrl }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Erreur Sunrise-Pay');
  }

  return {
    paymentId: data.id,
    paymentUrl: data.paymentUrl,
    status: data.status,
  };
}

export async function getPaymentStatus(paymentId) {
  const response = await fetch(`${config.sunrisePayUrl}/payments/${paymentId}`, {
    headers: headers(),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Paiement introuvable');
  }

  return data;
}
