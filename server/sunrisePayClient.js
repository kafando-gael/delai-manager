import {config} from './config.js';

const SUNRISE_TIMEOUT_MS = 25000;
const SUNRISE_COOLDOWN_MS = 10 * 60 * 1000;

let blockedUntil = 0;

function headers() {
  return {
    Authorization: `Bearer ${config.sunrisePayApiKey}`,
    'Content-Type': 'application/json',
  };
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {error: text.replace(/\s+/g, ' ').trim().slice(0, 200)};
  }
}

function rateLimitError() {
  const error = new Error('Trop de tentatives de paiement. Reessaie dans quelques minutes.');
  error.status = 429;
  error.code = 'RATE_LIMITED';
  return error;
}

function sunriseError(response, data, fallback) {
  const raw = data.error || data.message || fallback;
  const isRateLimited = response.status === 429 || /too many requests/i.test(String(raw));
  if (isRateLimited) {
    blockedUntil = Date.now() + SUNRISE_COOLDOWN_MS;
    return rateLimitError();
  }
  const error = new Error(raw);
  error.status = response.status;
  error.code = 'SUNRISE_ERROR';
  return error;
}

async function sunriseFetch(url, options = {}) {
  if (Date.now() < blockedUntil) {
    throw rateLimitError();
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SUNRISE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {...headers(), ...(options.headers || {})},
      signal: controller.signal,
    });
    const data = await parseBody(response);
    if (!response.ok) {
      throw sunriseError(response, data, 'Erreur Sunrise-Pay');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('Sunrise Pay ne repond pas. Reessaie dans un instant.');
      timeoutError.code = 'SUNRISE_TIMEOUT';
      timeoutError.status = 503;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function createPayment({purpose, amount, userId, metadata, callbackUrl}) {
  const data = await sunriseFetch(`${config.sunrisePayUrl}/payments`, {
    method: 'POST',
    body: JSON.stringify({purpose, amount, userId, metadata, callbackUrl}),
  });

  return {
    paymentId: data.id,
    paymentUrl: data.paymentUrl,
    status: data.status,
  };
}

export async function getPaymentStatus(paymentId) {
  return sunriseFetch(`${config.sunrisePayUrl}/payments/${paymentId}`);
}
