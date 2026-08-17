import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from 'node:path'

export default defineConfig({
 plugins: [react()],
 build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        cities: 'cities/index.html',
      }
    },
  },

});


