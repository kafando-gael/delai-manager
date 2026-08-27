const API_URL = (
  process.env.EXPO_PUBLIC_API_URL
  || 'http://localhost:3200/api'
).replace(/\/$/, '');

export const TRIAL_DURATION_MONTHS = 1;
export const TRIAL_DEADLINE_LIMIT = 4;

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    headers: {'Content-Type': 'application/json', ...(options.headers || {})},
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Erreur reseau');
  }
  return data;
}

export async function syncClientProfile({deviceId, name, email, phone, usageReason, ageRange}) {
  return request('/clients/sync', {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      name,
      email,
      phone,
      usageReason,
      ageRange,
    }),
  });
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
