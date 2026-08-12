import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// The mail manager is served under /admin on the R'NQ site. The build output
// is written to ../publish/admin so Netlify can publish the whole site (the
// static R'NQ root + this SPA) from one directory. See netlify.toml.
export default defineConfig({
  base: "/admin/",
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    outDir: path.resolve(__dirname, "../publish/admin"),
    emptyOutDir: true,
  },
});
