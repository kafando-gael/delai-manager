import {config} from '../config.js';

export function errorHandler(error, _req, res, _next) {
  console.error('[error]', error.message);
  const message = config.isProduction ? 'Erreur interne du serveur' : error.message;
  return res.status(500).json({error: message});
}
