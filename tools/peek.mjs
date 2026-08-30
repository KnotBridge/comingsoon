import fs from "fs";
import Papa from "papaparse";
const raw = fs.readFileSync(process.argv[1], "utf8");
const { data } = Papa.parse(raw, { header: true, skipEmptyLines: true });
console.log("rows:", data.length);
let withFirst = 0, withEmail = 0, withCompany = 0;
for (const r of data) {
  if ((r["First Name"]||"").trim()) withFirst++;
  if ((r["Email"]||r["email"]||"").trim()) withEmail++;
  if ((r["companyName"]||"").trim()) withCompany++;
}
console.log("have First Name:", withFirst, "| have Email:", withEmail, "| have companyName:", withCompany);
const want = ["First Name","Last Name","jobTitle","companyName","Email","location","status"];
console.log("\n--- 5 sample rows ---");
for (const r of data.slice(0, 5)) {
  console.log("  " + want.map(k => `${k.replace(" Name"," ")}=${JSON.stringify((r[k]||"").slice(0,30))}`).join("  "));
}
