// find-dmitriy.mjs — find Dmitriy Grechukha and pull his decision_log
import { SignJWT } from './node_modules/.pnpm/jose@6.1.0/node_modules/jose/dist/webapi/index.js';

const JWT_SECRET = process.env.JWT_SECRET;
const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID;
const OWNER_NAME = process.env.OWNER_NAME;
const APP_ID = process.env.VITE_APP_ID || '';

const secretKey = new TextEncoder().encode(JWT_SECRET);
const token = await new SignJWT({ openId: OWNER_OPEN_ID, appId: APP_ID, name: OWNER_NAME, role: 'admin' })
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(secretKey);

// Search for Dmitriy via leads.list
const r = await fetch('http://localhost:3000/api/trpc/leads.list?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%7D%7D', {
  headers: { 'Cookie': `app_session_id=${token}` }
});
const data = await r.json();
const leads = Array.isArray(data) ? data[0]?.result?.data?.json : data?.result?.data?.json;
if (!leads) {
  console.log('No leads data:', JSON.stringify(data).substring(0, 300));
  process.exit(1);
}
const dmitriy = leads.filter(l => l.name && (
  l.name.toLowerCase().includes('dmitriy') ||
  l.name.toLowerCase().includes('grechukha')
));
console.log(`\nDmitriy leads found: ${dmitriy.length}`);
dmitriy.forEach(l => {
  console.log(`  id=${l.id}, name=${l.name}, phone=${l.phone || 'N/A'}, status=${l.status}`);
});

if (dmitriy.length === 0) {
  // Try phone search
  const byPhone = leads.filter(l => l.phone && l.phone.includes('7869445535'));
  console.log(`\nPhone 7869445535 match: ${byPhone.length}`);
  byPhone.forEach(l => console.log(`  id=${l.id}, name=${l.name}, phone=${l.phone}`));
  process.exit(0);
}

// Get decision_log for the first Dmitriy lead
const leadId = dmitriy[0].id;
console.log(`\nFetching decision_log for lead ${leadId}...`);

const detailR = await fetch(`http://localhost:3000/api/trpc/leads.detail?batch=1&input=%7B%220%22%3A%7B%22json%22%3A%7B%22id%22%3A${leadId}%7D%7D%7D`, {
  headers: { 'Cookie': `app_session_id=${token}` }
});
const detailData = await detailR.json();
const detail = Array.isArray(detailData) ? detailData[0]?.result?.data?.json : detailData?.result?.data?.json;

if (!detail) {
  console.log('No detail data:', JSON.stringify(detailData).substring(0, 300));
  process.exit(1);
}

// Print AI state / decision_log
console.log('\n=== AI State ===');
const aiState = detail.state;
if (aiState) {
  console.log('humanTakeover:', aiState.humanTakeover);
  console.log('lastActivity:', aiState.lastActivity);
  console.log('decisionLog (last 5):');
  const log = aiState.decisionLog || [];
  log.slice(-5).forEach((entry, i) => {
    console.log(`  [${i}] ${JSON.stringify(entry).substring(0, 200)}`);
  });
} else {
  console.log('No AI state found');
}

// Print recent conversation
console.log('\n=== Recent Conversation (last 10) ===');
const history = detail.history || [];
history.slice(-10).forEach(msg => {
  const ts = msg.sentAt ? new Date(msg.sentAt).toISOString() : 'unknown';
  const dir = msg.direction || '?';
  const body = (msg.body || '').substring(0, 100);
  console.log(`  [${ts}] ${dir}: ${body}`);
});
