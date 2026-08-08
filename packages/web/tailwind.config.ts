import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#FAF7F2", // Cream
        foreground: "#111827",
        primary: {
          DEFAULT: "#0F5C5C",
          dark: "#1B7A7A",
        },
        accent: {
          DEFAULT: "#FF7A59",
        }
      },
      fontFamily: {
        sans: ["var(--font-inter)", "sans-serif"],
        display: ["var(--font-merriweather)", "serif"],
      },
      borderRadius: {
        'xl': '16px',
        '2xl': '24px',
      }
    },
  },
  plugins: [],
};
export default config;
