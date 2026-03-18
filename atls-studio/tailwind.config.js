/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // ATLS Studio color palette - dark with electric blue titles
        studio: {
          bg: '#0a0a0a',
          surface: '#141414',
          border: '#262626',
          text: '#e5e5e5',
          muted: '#737373',
          title: '#58a6ff',
          accent: '#a3a3a3',
          'accent-bright': '#d4d4d4',
          success: '#22c55e',
          warning: '#eab308',
          error: '#ef4444',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
