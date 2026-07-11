import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind to all interfaces (0.0.0.0) so the dev server is reachable
    // via the machine's public IP, not just localhost.
    host: true,
    // Allow access via this host (Vite blocks unknown hosts by default).
    allowedHosts: ["13.233.159.84"],
    // Proxy API calls to the Express server during development.
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
});
