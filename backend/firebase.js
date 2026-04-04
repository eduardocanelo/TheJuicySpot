// Inicialización compartida de Firebase Admin
// Importar este módulo en lugar de inicializar Firebase directamente
const admin = require('firebase-admin');
require('dotenv').config();

if (!admin.apps.length) {
  let credential;
  if (process.env.FIREBASE_PROJECT_ID) {
    const rawKey = process.env.FIREBASE_PRIVATE_KEY || '';
    const pk = rawKey.indexOf('\\n') !== -1 ? rawKey.split('\\n').join('\n') : rawKey;
    credential = admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  pk,
    });
  } else {
    credential = admin.credential.cert(require('./firebase-service-account.json'));
  }
  admin.initializeApp({ credential });
}

module.exports = admin;
