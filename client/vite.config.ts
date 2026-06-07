import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VoltPass client. BrowserRouter serves /resident and /owner, so we need SPA
// fallback (Vite dev server does this by default for the React plugin).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    // The Smartcar connector (secrets live there) runs separately; proxy /api to it.
    proxy: {
      "/api": {
        target: process.env.VOLTPASS_API_URL ?? "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
