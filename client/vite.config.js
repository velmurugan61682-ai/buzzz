import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": { target: process.env.VITE_API_URL || "http://localhost:4000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("react") || id.includes("react-dom")) return "vendor-react";
            if (id.includes("recharts") || id.includes("d3") || id.includes("recharts-scale")) return "vendor-charts";
            if (id.includes("lucide-react")) return "vendor-icons";
            return "vendor-utils";
          }
        },
      },
    },
  },
});
