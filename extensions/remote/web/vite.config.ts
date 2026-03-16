import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    proxy: {
      "/ws/terminal": {
        target: "ws://127.0.0.1:7009",
        ws: true,
      },
      "/api": {
        target: "http://127.0.0.1:7009",
      },
    },
  },
});
