const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

function requireEnv(name, {productionOnly = false} = {}) {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (productionOnly && !isProduction) {
    return '';
  }
  throw new Error(`Variable d'environnement manquante: ${name}`);
}

function loadConfig() {
  const config = {
    nodeEnv: NODE_ENV,
    isProduction,
    port: parseInt(process.env.PORT || '3200', 10),
    annualFcfa: Number(process.env.SUBSCRIPTION_ANNUAL_FCFA || 1000),
    returnScheme: process.env.APP_RETURN_SCHEME || 'delai-manager',
    publicApiUrl: process.env.PUBLIC_API_URL?.replace(/\/$/, '') || '',
    sunrisePayUrl: (process.env.SUNRISE_PAY_URL || 'http://localhost:3100').replace(/\/$/, ''),
    sunrisePayApiKey: process.env.SUNRISE_PAY_API_KEY?.trim() || '',
    supabaseUrl: requireEnv('SUPABASE_URL'),
    supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    webhookSecret: process.env.WEBHOOK_SECRET?.trim() || '',
    corsOrigins: (process.env.CORS_ORIGINS || '')
      .split(',')
      .map(origin => origin.trim())
      .filter(Boolean),
  };

  if (isProduction) {
    if (!config.sunrisePayApiKey) {
      throw new Error('SUNRISE_PAY_API_KEY requis en production');
    }
    if (!config.publicApiUrl) {
      throw new Error('PUBLIC_API_URL requis en production (webhooks Sunrise Pay)');
    }
    if (!config.webhookSecret) {
      throw new Error('WEBHOOK_SECRET requis en production');
    }
    if (config.publicApiUrl.includes('localhost')) {
      throw new Error('PUBLIC_API_URL ne peut pas etre localhost en production');
    }
  }

  return config;
}

export const config = loadConfig();
