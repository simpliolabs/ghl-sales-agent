import 'dotenv/config';

async function main() {
  const key = process.env.GHL_API_KEY;
  const loc = process.env.GHL_LOCATION_ID;
  console.log('LOC:', loc ? loc.substring(0,8)+'...' : 'MISSING');
  
  // Try multiple GHL webhook endpoints
  const endpoints = [
    `https://services.leadconnectorhq.com/webhooks/?locationId=${loc}&altType=location&altId=${loc}`,
    `https://rest.gohighlevel.com/v1/webhooks/`,
    `https://services.leadconnectorhq.com/locations/${loc}/webhooks/`,
  ];
  
  for (const url of endpoints) {
    console.log('\nTrying:', url);
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${key}`, 'Version': '2021-07-28', 'Content-Type': 'application/json' }
    });
    console.log('Status:', r.status);
    const text = await r.text();
    if (text) {
      try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text.substring(0, 500)); }
    }
    if (r.status === 200) break;
  }
}

main().catch(console.error);
