import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Relative by default, so one build works both from a domain root
  // (example.com) and from a project subpath (user.github.io/repo/).
  // Set VITE_BASE=/repo/ when you want a fixed absolute prefix instead.
  base: process.env.VITE_BASE ?? "./",
  server: {
    port: 5173,
  },
  build: {
    target: "es2022",
    // Long-lived hashed filenames need long-lived caching; index.html must not
    // be cached or people keep getting old asset URLs after a deploy.
    assetsDir: "assets",
    rollupOptions: {
      output: {
        // Split the vendor code out of the app chunk. Without this the whole
        // 500kB bundle changes on every UI tweak, which invalidates everyone's
        // cache; with it, only the small app chunk moves.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // jszip is dynamically imported and lands in its own lazy chunk.
          if (id.includes("jszip")) return;
          if (id.includes("lucide-react")) return "vendor-icons";
          if (id.includes("@radix-ui")) return "vendor-radix";
          if (id.includes("sonner")) return "vendor-toast";
          if (
            id.includes("node_modules/react/") ||
            id.includes("node_modules/react-dom/") ||
            id.includes("node_modules/scheduler/")
          ) {
            return "vendor-react";
          }
          return "vendor";
        },
      },
    },
  },
});
