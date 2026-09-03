import Constants from 'expo-constants';

function resolveApiUrl() {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  const fromExtra = Constants.expoConfig?.extra?.apiUrl;
  const raw = (fromEnv || fromExtra || 'http://localhost:3200/api').replace(/\/$/, '');
  return raw;
}

const API_URL = resolveApiUrl();
const REQUEST_TIMEOUT_MS = 25000;
const PAY_TIMEOUT_MS = 45000;

export const TRIAL_DURATION_MONTHS = 1;
export const TRIAL_DEADLINE_LIMIT = 4;

function errorFromStatus(status, data) {
  if (status === 429) {
    return data.error || 'Trop de requetes. Reessaie dans quelques minutes.';
  }
  if (status >= 500) {
    return data.error || 'Serveur indisponible. Reessaie dans un instant.';
  }
  return data.error || 'Erreur reseau';
}

async function request(path, {timeoutMs = REQUEST_TIMEOUT_MS, headers, ...options} = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {'Content-Type': 'application/json', ...(headers || {})},
      signal: controller?.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(errorFromStatus(response.status, data));
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Le serveur met trop de temps a repondre. Reessaie.');
    }
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

let syncClientInFlight = null;

export async function syncClientProfile({deviceId, name, email, phone, usageReason, ageRange}) {
  if (syncClientInFlight) {
    return syncClientInFlight;
  }

  syncClientInFlight = request('/clients/sync', {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      name,
      email,
      phone,
      usageReason,
      ageRange,
    }),
  }).finally(() => {
    syncClientInFlight = null;
  });

  return syncClientInFlight;
}

export async function fetchSubscriptionStatus(deviceId) {
  return request(`/subscription/status?deviceId=${encodeURIComponent(deviceId)}`);
}

export async function startSubscriptionPayment({
  deviceId,
  customerEmail,
  customerPhone,
  customerName,
  usageReason,
  ageRange,
}) {
  return request('/subscription/pay', {
    method: 'POST',
    timeoutMs: PAY_TIMEOUT_MS,
    body: JSON.stringify({
      deviceId,
      customerEmail,
      customerName,
      usageReason,
      ageRange,
      ...(customerPhone ? {customerPhone} : {}),
    }),
  });
}

export async function confirmSubscriptionPayment(deviceId, paymentId) {
  return request('/subscription/confirm', {
    method: 'POST',
    timeoutMs: PAY_TIMEOUT_MS,
    body: JSON.stringify({deviceId, paymentId}),
  });
}

export async function cancelSubscriptionPayment(deviceId, paymentId) {
  return request('/subscription/cancel', {
    method: 'POST',
    body: JSON.stringify({deviceId, paymentId}),
  });
}

export function isSubscriptionActive(status) {
  return Boolean(status?.isActive);
}

export function getTrialEndDate(trialStartedAt) {
  if (!trialStartedAt) {
    return null;
  }
  const end = new Date(trialStartedAt);
  if (Number.isNaN(end.getTime())) {
    return null;
  }
  end.setMonth(end.getMonth() + TRIAL_DURATION_MONTHS);
  return end;
}

export function buildTrialInfo(trialStartedAt) {
  const trialEndsAtDate = getTrialEndDate(trialStartedAt);
  if (!trialEndsAtDate) {
    return {
      trialStartedAt: null,
      trialEndsAt: null,
      isTrialActive: false,
      trialDaysLeft: 0,
      deadlineLimit: 0,
    };
  }

  const now = new Date();
  const isTrialActive = now < trialEndsAtDate;
  const trialDaysLeft = isTrialActive
    ? Math.max(0, Math.ceil((trialEndsAtDate - now) / (1000 * 60 * 60 * 24)))
    : 0;

  return {
    trialStartedAt,
    trialEndsAt: trialEndsAtDate.toISOString(),
    isTrialActive,
    trialDaysLeft,
    deadlineLimit: isTrialActive ? TRIAL_DEADLINE_LIMIT : 0,
  };
}

export function mergeSubscriptionWithTrial(remoteStatus, trialStartedAt) {
  const trial = buildTrialInfo(trialStartedAt);
  const isActive = Boolean(remoteStatus?.isActive);

  return {
    annualPriceFcfa: remoteStatus?.annualPriceFcfa ?? 1000,
    freeDeadlineLimit: TRIAL_DEADLINE_LIMIT,
    isActive,
    daysLeft: remoteStatus?.daysLeft ?? 0,
    endsAt: remoteStatus?.endsAt || null,
    status: remoteStatus?.status || (trial.isTrialActive ? 'trial' : 'none'),
    pendingPaymentId: remoteStatus?.pendingPaymentId || null,
    ...trial,
    deadlineLimit: isActive ? Infinity : trial.deadlineLimit,
  };
}

export function canAddDeadline(deadlineCount, status) {
  if (isSubscriptionActive(status)) {
    return true;
  }
  if (status?.isTrialActive) {
    return deadlineCount < TRIAL_DEADLINE_LIMIT;
  }
  return false;
}
