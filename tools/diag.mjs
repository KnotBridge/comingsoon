import fs from "fs";
const p = process.argv[1];
const st = fs.statSync(p);
console.log("statSync.size:", st.size);
const buf = fs.readFileSync(p);            // Buffer, no encoding
console.log("readFileSync Buffer bytes:", buf.length);
console.log("first line bytes:", buf.slice(0, buf.indexOf(10)).length);
// count real newlines in the buffer
let nl = 0; for (let i=0;i<buf.length;i++) if (buf[i]===10) nl++;
console.log("newline (0x0A) count in buffer:", nl);
// how many 0x00 bytes? (would truncate a naive string)
let z = 0; for (let i=0;i<Math.min(buf.length,5000);i++) if (buf[i]===0) z++;
console.log("NUL bytes in first 5000:", z);
