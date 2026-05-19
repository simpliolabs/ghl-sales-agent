/**
 * Foundation A Post-Deploy Verification Script
 * 
 * Generates a valid admin JWT session cookie and calls the verifyFoundationA
 * tRPC endpoint on the local dev server (same runtime as production).
 */
import { SignJWT } from "jose";

const JWT_SECRET = process.env.JWT_SECRET;
const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID;
const APP_ID = process.env.VITE_APP_ID;

if (!JWT_SECRET || !OWNER_OPEN_ID || !APP_ID) {
  console.error("Missing required env vars: JWT_SECRET, OWNER_OPEN_ID, VITE_APP_ID");
  process.exit(1);
}

async function main() {
  // Generate a valid admin session JWT (same logic as sdk.ts signSession)
  const secretKey = new TextEncoder().encode(JWT_SECRET);
  const expirationSeconds = Math.floor((Date.now() + 86400000) / 1000); // +24h

  const token = await new SignJWT({
    openId: OWNER_OPEN_ID,
    appId: APP_ID,
    name: "Admin Verification",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(secretKey);

  console.log("[1] Generated admin session JWT");

  // Call the verifyFoundationA endpoint
  const url = "http://localhost:3000/api/trpc/verifyFoundationA";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": `app_session_id=${token}`,
    },
    body: JSON.stringify({}),
  });

  const status = resp.status;
  const body = await resp.text();
  
  console.log(`[2] HTTP ${status}`);
  console.log(`[3] Response body:`);
  
  try {
    const parsed = JSON.parse(body);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(body);
  }

  if (status === 200) {
    console.log("\n✅ SYNTHETIC WRITE SUCCEEDED — Foundation A is deployed and functional");
  } else {
    console.error("\n❌ SYNTHETIC WRITE FAILED — Foundation A may not be correctly deployed");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Script error:", err);
  process.exit(1);
});
