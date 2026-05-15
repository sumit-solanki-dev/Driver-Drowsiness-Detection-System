/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b1220",
        panel: "#121b2f",
        accent: "#32d4b5",
        warn: "#f59e0b",
        danger: "#ef4444"
      },
      fontFamily: {
        sans: ["Poppins", "system-ui", "sans-serif"]
      },
      keyframes: {
        pulseAlert: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" }
        }
      },
      animation: {
        pulseAlert: "pulseAlert 1s infinite"
      }
    }
  },
  plugins: []
};
