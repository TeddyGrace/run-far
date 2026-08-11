import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "#121815",
          1: "#1B2320",
          2: "#232D29",
        },
        border: {
          DEFAULT: "#2E3A35",
        },
        ink: {
          primary: "#EDEAE2",
          secondary: "#9FADA5",
          muted: "#6C7A73",
        },
        accent: {
          DEFAULT: "#4FB0A6",
          strong: "#6FD1C6",
        },
        zone: {
          good: "#6FAE6B",
          yellow: "#D9A548",
          red: "#D1554B",
          info: "#7C96B8",
        },
      },
      fontFamily: {
        display: ["Space Grotesk", "system-ui", "sans-serif"],
        body: ["Inter", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
