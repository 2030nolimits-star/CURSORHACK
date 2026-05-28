import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: { mono: ["JetBrains Mono", "Fira Code", "monospace"] },
      colors: {
        brand: {
          50: "#f0fdf4",
          500: "#22c55e",
          600: "#16a34a",
          900: "#14532d",
        },
      },
    },
  },
  plugins: [],
};

export default config;
