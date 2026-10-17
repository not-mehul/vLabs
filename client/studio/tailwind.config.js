// Tailwind for vLabs Template Studio (the same theme the Studio used with the
// Tailwind CDN, now compiled at build time so the Studio works offline and
// under the app's Content-Security-Policy).
import { fileURLToPath } from 'node:url';

export default {
  darkMode: 'class',
  content: [fileURLToPath(new URL('./src', import.meta.url)) + '/**/*.{html,js}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: [
          'JetBrains Mono',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      colors: {
        brand: {
          50: '#f0f4ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
        },
        surface: {
          750: '#222530',
          800: '#181a20',
          850: '#12141a',
          900: '#0d0f14',
          950: '#08090c',
        },
      },
      boxShadow: {
        '2xs': '0 1px 2px 0 rgba(15, 23, 42, 0.03)',
        xs: '0 1px 3px 0 rgba(15, 23, 42, 0.04), 0 1px 2px -1px rgba(15, 23, 42, 0.03)',
        elevated: '0 10px 30px -5px rgba(15, 23, 42, 0.08), 0 4px 12px -2px rgba(15, 23, 42, 0.04)',
      },
    },
  },
};
