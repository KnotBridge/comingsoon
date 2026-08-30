import fs from "fs";
import Papa from "papaparse";
const raw = fs.readFileSync(process.argv[1], "utf8");
const res = Papa.parse(raw, { header: true, skipEmptyLines: "greedy" });
console.log("parsed rows:", res.data.length, "| errors:", res.errors.slice(0,2).map(e=>e.code+"@"+e.row).join(","));
console.log("keys count:", Object.keys(res.data[0]||{}).length);
const r = res.data.find(x => (x["First Name"]||x["Email"]||x["companyName"]||"").trim()) || res.data[0];
for (const k of ["First Name","Last Name","Email","companyName","jobTitle","location"]) console.log(`  [${k}] = ${JSON.stringify((r?.[k]||"").slice(0,40))}`);
