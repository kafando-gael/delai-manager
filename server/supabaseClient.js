import {createClient} from '@supabase/supabase-js';

import {config} from './config.js';

let client;

export function getSupabase() {
  if (client) {
    return client;
  }

  client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {autoRefreshToken: false, persistSession: false},
  });

  return client;
}
