import {getSupabase} from './supabaseClient.js';

function mapSubscription(row) {
  if (!row) {
    return null;
  }

  return {
    deviceId: row.device_id,
    status: row.status,
    planCode: row.plan_code,
    amountPaid: row.amount_paid,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    pendingPaymentId: row.pending_payment_id,
    lastPaymentId: row.last_payment_id,
    updatedAt: row.updated_at,
  };
}

export function isSubscriptionActive(record) {
  if (!record || record.status !== 'active' || !record.endsAt) {
    return false;
  }
  return new Date(record.endsAt) > new Date();
}

export function addOneYear(fromDate = new Date()) {
  const date = new Date(fromDate);
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString();
}

export async function upsertClient({deviceId, name, email, phone, usageReason, ageRange}) {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  const {data, error} = await supabase
    .from('clients')
    .upsert(
      {
        device_id: deviceId,
        name: name || null,
        email: email || null,
        phone: phone || null,
        usage_reason: usageReason || null,
        age_range: ageRange || null,
        updated_at: now,
      },
      {onConflict: 'device_id'},
    )
    .select('id')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function getSubscription(deviceId) {
  const supabase = getSupabase();

  const {data, error} = await supabase
    .from('subscriptions')
    .select('*')
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return mapSubscription(data);
}

export async function saveSubscription(deviceId, patch, clientId = null) {
  const supabase = getSupabase();
  const now = new Date().toISOString();

  const row = {
    device_id: deviceId,
    updated_at: now,
  };

  if (clientId) {
    row.client_id = clientId;
  }
  if (patch.status !== undefined) {
    row.status = patch.status;
  }
  if (patch.planCode !== undefined) {
    row.plan_code = patch.planCode;
  }
  if (patch.amountPaid !== undefined) {
    row.amount_paid = patch.amountPaid;
  }
  if (patch.startsAt !== undefined) {
    row.starts_at = patch.startsAt;
  }
  if (patch.endsAt !== undefined) {
    row.ends_at = patch.endsAt;
  }
  if (patch.pendingPaymentId !== undefined) {
    row.pending_payment_id = patch.pendingPaymentId;
  }
  if (patch.lastPaymentId !== undefined) {
    row.last_payment_id = patch.lastPaymentId;
  }

  const {data, error} = await supabase
    .from('subscriptions')
    .upsert(row, {onConflict: 'device_id'})
    .select('*')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return mapSubscription(data);
}

export async function createPaymentRecord({deviceId, clientId, sunrisePaymentId, amount, paymentUrl}) {
  const supabase = getSupabase();

  const {data, error} = await supabase
    .from('payments')
    .insert({
      device_id: deviceId,
      client_id: clientId,
      sunrise_payment_id: sunrisePaymentId,
      amount,
      status: 'pending',
      payment_url: paymentUrl || null,
    })
    .select('id')
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

function mapPayment(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    deviceId: row.device_id,
    clientId: row.client_id,
    sunrisePaymentId: row.sunrise_payment_id,
    amount: row.amount,
    status: row.status,
    paymentUrl: row.payment_url || null,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function getLatestPaymentForDevice(deviceId) {
  const supabase = getSupabase();

  const {data, error} = await supabase
    .from('payments')
    .select('*')
    .eq('device_id', deviceId)
    .order('created_at', {ascending: false})
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return mapPayment(data);
}

export async function updatePaymentUrl(sunrisePaymentId, paymentUrl) {
  if (!paymentUrl) {
    return;
  }
  const supabase = getSupabase();
  const {error} = await supabase
    .from('payments')
    .update({payment_url: paymentUrl})
    .eq('sunrise_payment_id', sunrisePaymentId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function getPaymentRecord(sunrisePaymentId) {
  const supabase = getSupabase();

  const {data, error} = await supabase
    .from('payments')
    .select('*')
    .eq('sunrise_payment_id', sunrisePaymentId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return mapPayment(data);
}

export async function checkDatabaseConnection() {
  const supabase = getSupabase();
  const {error} = await supabase.from('clients').select('id').limit(1);
  if (error) {
    throw new Error(error.message);
  }
  return true;
}

export async function updatePaymentStatus(sunrisePaymentId, status) {
  const supabase = getSupabase();
  const patch = {status};

  if (status === 'completed') {
    patch.completed_at = new Date().toISOString();
  }

  const {error} = await supabase
    .from('payments')
    .update(patch)
    .eq('sunrise_payment_id', sunrisePaymentId);

  if (error) {
    throw new Error(error.message);
  }
}

export async function markPaymentCompleted(sunrisePaymentId) {
  return updatePaymentStatus(sunrisePaymentId, 'completed');
}

export async function clearPendingSubscription(deviceId) {
  const current = await getSubscription(deviceId);
  if (!current || current.status !== 'pending_payment') {
    return current;
  }

  return saveSubscription(deviceId, {
    status: isSubscriptionActive(current) ? 'active' : 'none',
    pendingPaymentId: null,
  });
}
