/**
 * Standalone disposition sweep runner
 * Bypasses tRPC auth by importing the module directly via tsx
 */
import { runDispositionSweep } from "./server/lead-disposition.ts";

console.log("[Disposition] Starting sweep...");
const stats = await runDispositionSweep();
console.log("[Disposition] Sweep complete:", JSON.stringify(stats, null, 2));
process.exit(0);
