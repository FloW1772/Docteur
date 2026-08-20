/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'n-bg':      '#0a0814',
        'n-surface': '#0f0b1e',
        'n-panel':   '#13102a',
        'n-border':  '#1e1535',
        'n-border2': '#2a1f4a',
        'n-emerald': '#3dffaa',
        'n-magenta': '#ff4dcb',
        'n-cyan':    '#5ee7ff',
        'n-violet':  '#a78bfa',
        'n-text':    '#e8e0ff',
        'n-muted':   '#7060a0',
        'n-dim':     '#3d3060',
      },
      fontFamily: {
        'grotesk': ['Space Grotesk', 'sans-serif'],
        'mono':    ['IBM Plex Mono', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4,0,0.6,1) infinite',
        'float':      'float 6s ease-in-out infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%':      { transform: 'translateY(-6px)' },
        },
      },
    },
  },
  plugins: [],
};
