import mysql from "mysql2/promise";
import { ENV } from "./server/_core/env.ts";

console.log("Connecting to DB...");
const conn = await mysql.createConnection(ENV.databaseUrl);
console.log("Connected!");
const [r] = await conn.query("SELECT COUNT(*) as c FROM leads");
console.log("Count:", r[0].c);
await conn.end();
console.log("Done");
