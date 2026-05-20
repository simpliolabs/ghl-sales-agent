// verify-foundation-d.mjs — runs verifyFoundationD against the local dev server
// Uses JWT_SECRET from env to generate a valid admin session token
import { readFileSync } from 'fs';
import { SignJWT } from './node_modules/.pnpm/jose@6.1.0/node_modules/jose/dist/webapi/index.js';

// Load env from process.env (injected by the webdev shell)
const JWT_SECRET = process.env.JWT_SECRET;
const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID;
const OWNER_NAME = process.env.OWNER_NAME;

if (!JWT_SECRET) {
  console.error('ERROR: JWT_SECRET not found in env');
  process.exit(1);
}

console.log('OWNER_OPEN_ID:', OWNER_OPEN_ID ? OWNER_OPEN_ID.substring(0, 8) + '...' : 'NOT SET');
console.log('OWNER_NAME:', OWNER_NAME);

// Sign JWT using jose
const secretKey = new TextEncoder().encode(JWT_SECRET);
const APP_ID = process.env.VITE_APP_ID || '';
console.log('APP_ID:', APP_ID ? APP_ID.substring(0, 8) + '...' : 'NOT SET');
const token = await new SignJWT({ openId: OWNER_OPEN_ID, appId: APP_ID, name: OWNER_NAME, role: 'admin' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(secretKey);
console.log('Generated admin token (first 40 chars):', token.substring(0, 40) + '...');

// Call verifyFoundationD on the local dev server
const TIMESTAMP = new Date().toISOString();
console.log('\nCalling verifyFoundationD at:', TIMESTAMP);

const response = await fetch('http://localhost:3000/api/trpc/verifyFoundationD', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Cookie': `app_session_id=${token}`,
  },
  body: JSON.stringify({ '0': { json: null } }),
});

const body = await response.json();
console.log('\n=== verifyFoundationD RESULT ===');
console.log('HTTP Status:', response.status);
console.log('Response:', JSON.stringify(body, null, 2));

// Response may be wrapped in array (batch) or direct object
const result = Array.isArray(body) ? body[0]?.result?.data?.json : body?.result?.data?.json;
if (result?.success) {
  console.log('\n✅ Foundation D VERIFIED on local dev server');
  console.log('first_acquired:', result.first_acquired);
  console.log('second_acquired:', result.second_acquired);
  console.log('Message:', result.message);
} else {
  console.log('\n❌ Foundation D verification FAILED or unexpected response');
  if (body[0]?.error) {
    console.log('Error:', body[0].error.json?.message);
  }
}
