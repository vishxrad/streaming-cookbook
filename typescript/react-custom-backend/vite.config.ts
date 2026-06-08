import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:9123",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
