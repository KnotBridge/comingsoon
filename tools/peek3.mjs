import fs from "fs";
import Papa from "papaparse";
const raw = fs.readFileSync(process.argv[1], "utf8");
console.log("bytes:", raw.length);
console.log("has \r\n:", raw.includes("\r\n"), "| lone \r:", /\r(?!\n)/.test(raw), "| \n count:", (raw.match(/\n/g)||[]).length);
console.log("header comma count:", (raw.split(/\r?\n/)[0].match(/,/g)||[]).length + 1, "fields");
// robust parse: let Papa auto-detect, no skipEmptyLines quirks
const res = Papa.parse(raw, { header: true });
console.log("\nPapa rows:", res.data.length, "| fields in row0:", Object.keys(res.data[0]||{}).length);
if (res.errors.length) console.log("errors:", res.errors.slice(0,3));
// Count how many rows actually have a First Name
let named = 0, emailed = 0;
for (const r of res.data) { if ((r["First Name"]||"").trim()) named++; if ((r["Email"]||"").trim()) emailed++; }
console.log("rows with First Name:", named, "| with Email:", emailed);
// show first row that has a first name
const hit = res.data.find(r => (r["First Name"]||"").trim());
if (hit) console.log("\nsample:", JSON.stringify({first:hit["First Name"], last:hit["Last Name"], email:hit["Email"], company:hit["companyName"], title:hit["jobTitle"]}));
else console.log("\nNO row has a First Name value");
