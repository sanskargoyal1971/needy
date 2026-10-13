import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        background: "#FAF7F2", // Cream
        foreground: "#111827",
        primary: {
          DEFAULT: "#0F5C5C",
          dark: "#1B7A7A",
          100: "#E6F0F0",
        },
        accent: {
          DEFAULT: "#FF7A59",
          light: "#FFA087",
        }
      },
      fontFamily: {
        sans: ["var(--font-inter)", "sans-serif"],
        display: ["var(--font-merriweather)", "serif"],
      },
      borderRadius: {
        'xl': '16px',
        '2xl': '24px',
        '3xl': '32px',
      },
      boxShadow: {
        '3d-button': '0 6px 0 0 rgba(15, 92, 92, 1), 0 10px 10px rgba(0, 0, 0, 0.1)',
        '3d-button-hover': '0 2px 0 0 rgba(15, 92, 92, 1), 0 5px 5px rgba(0, 0, 0, 0.1)',
        '3d-card': '0 10px 20px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1), inset 0 -2px 0 0 rgba(0,0,0,0.05), inset 0 2px 0 0 rgba(255,255,255,0.5)',
        '3d-card-hover': '0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 10px 10px -5px rgba(0, 0, 0, 0.1), inset 0 -2px 0 0 rgba(0,0,0,0.05), inset 0 2px 0 0 rgba(255,255,255,0.5)',
        'glass': '0 8px 32px 0 rgba(31, 38, 135, 0.07)',
      },
      animation: {
        'float': 'float 6s ease-in-out infinite',
        'float-delayed': 'float 6s ease-in-out 3s infinite',
        'pulse-slow': 'pulse 4s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow': 'glow 3s ease-in-out infinite alternate',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-15px)' },
        },
        glow: {
          '0%': { boxShadow: '0 0 15px rgba(255, 122, 89, 0.2)' },
          '100%': { boxShadow: '0 0 30px rgba(255, 122, 89, 0.6)' },
        }
      }
    },
  },
  plugins: [],
};
export default config;
