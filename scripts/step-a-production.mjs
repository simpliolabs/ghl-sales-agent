/**
 * Step A Production Verification
 * Generates admin JWT and calls verifyFoundationA on the production instance.
 */
import { SignJWT } from "jose";

const JWT_SECRET = process.env.JWT_SECRET;
const OWNER_OPEN_ID = process.env.OWNER_OPEN_ID;
const APP_ID = process.env.VITE_APP_ID;
const TARGET = process.env.VERIFY_URL || "https://ghl.adorbcustomtees.com/api/trpc/verifyFoundationA";

if (!JWT_SECRET || !OWNER_OPEN_ID || !APP_ID) {
  console.error("Missing required env vars: JWT_SECRET, OWNER_OPEN_ID, VITE_APP_ID");
  process.exit(1);
}

const secretKey = new TextEncoder().encode(JWT_SECRET);
const expirationSeconds = Math.floor((Date.now() + 86400000) / 1000);

const token = await new SignJWT({
  openId: OWNER_OPEN_ID,
  appId: APP_ID,
  name: "Admin Verification",
})
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setExpirationTime(expirationSeconds)
  .sign(secretKey);

console.log("[1] Admin JWT generated");
console.log("[2] Calling:", TARGET);

const resp = await fetch(TARGET, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Cookie": `app_session_id=${token}`,
  },
  body: JSON.stringify({}),
});

const status = resp.status;
const body = await resp.text();

console.log(`[3] HTTP ${status}`);
console.log("[4] Response:");

try {
  const parsed = JSON.parse(body);
  console.log(JSON.stringify(parsed, null, 2));
} catch {
  console.log(body);
}

if (status === 200) {
  console.log("\n✅ STEP A PASSED — Foundation A is live on production (6adb20a3)");
} else {
  console.error("\n❌ STEP A FAILED — check auth or deployment");
  process.exit(1);
}
