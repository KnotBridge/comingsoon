// Guarantee the Vite entry HTML is the SOURCE template before every build.
// If a previously *built* index.html (with hashed /admin/assets/... links) ever
// lands here, Vite fails with "Rollup failed to resolve import". Rewriting it
// first makes the build self-healing and impossible to break that way.
import { writeFileSync } from "fs";

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/png" href="/logo.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>R'NQ | Mail Manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

writeFileSync(new URL("./index.html", import.meta.url), html);
console.log("prebuild: restored source admin/index.html");
