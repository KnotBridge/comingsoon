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
  // In dev, /api/* goes to the local mailer (npm run local) instead of Netlify,
  // so sending, flows and PSD rendering all work with nothing deployed.
  server: {
    proxy: {
      "/api": {
        target: process.env.LOCAL_API || "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../publish/admin"),
    emptyOutDir: true,
  },
});
