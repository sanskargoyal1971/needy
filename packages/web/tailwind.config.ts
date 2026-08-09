import type { Config } from "tailwindcss";

const config: Config = {
  /**
   * ONE glob over the whole of `src`, not a list of the directories that existed when this
   * file was written.
   *
   * The previous list covered `pages`, `components` and `app` only — so every class used
   * *exclusively* inside `admin/`, `auth/`, `lib/`, `motion/`, `onboarding/`, `experience/` or
   * `realtime/` was silently never generated. It mostly went unnoticed because those
   * components lean on the same utilities the pages use (`flex`, `text-sm`, `rounded-2xl`),
   * which the pages caused to be emitted anyway. The failure only becomes visible on a class
   * that happens to be unique to one of them — `h-56` on the map container, which therefore
   * rendered at zero height with the class correctly applied and no rule behind it.
   *
   * That is a genuinely nasty failure mode: nothing errors, the markup looks right in the
   * inspector, and the element is simply invisible. A directory-by-directory list re-arms it
   * every time someone adds a folder, so the fix is to stop maintaining the list.
   */
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
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
