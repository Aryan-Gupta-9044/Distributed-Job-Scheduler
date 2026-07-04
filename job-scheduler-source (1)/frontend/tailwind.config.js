/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0B0F14",
        panel: "#121820",
        panel2: "#171F29",
        line: "#232E3B",
        signal: {
          queued: "#5B8DEF",
          running: "#E8A83C",
          completed: "#39C08E",
          failed: "#E85C5C",
          dead: "#8C2F39",
          cancelled: "#5B6472",
        },
        text: {
          hi: "#EDF1F5",
          mid: "#9FB0C0",
          low: "#5C6C7C",
        },
      },
      fontFamily: {
        display: ["'Space Grotesk'", "sans-serif"],
        mono: ["'IBM Plex Mono'", "monospace"],
        body: ["'Inter'", "sans-serif"],
      },
    },
  },
  plugins: [],
};
