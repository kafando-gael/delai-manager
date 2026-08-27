import {config} from '../config.js';

export function verifyWebhookSecret(req, res, next) {
  if (!config.webhookSecret) {
    return next();
  }

  const headerSecret = req.get('x-webhook-secret') || req.get('x-sunrise-signature');
  const bearer = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  const bodySecret = req.body?.secret;

  const provided = headerSecret || bearer || bodySecret;
  if (provided !== config.webhookSecret) {
    return res.status(401).json({error: 'Webhook non autorise'});
  }

  return next();
}
