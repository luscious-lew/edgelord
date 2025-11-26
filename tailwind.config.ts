import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        edgelord: {
          bg: "#050816",
          surface: "#0B1020",
          raised: "#111827",
          border: "#1F2937",
          primary: "#FF3E9E",
          primarySoft: "#F472B6",
          secondary: "#7C3AED",
          text: {
            primary: "#F9FAFB",
            muted: "#9CA3AF",
            dim: "#6B7280",
          },
          edge: {
            positive: "#22C55E",
            negative: "#EF4444",
            warning: "#FACC15",
            info: "#38BDF8",
          },
        },
      },
    },
  },
  plugins: [],
}
export default config
