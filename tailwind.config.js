/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./renderer/index.html",
    "./renderer/src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 科技蓝主题
        'tech-blue': '#2563EB',
        'tech-blue-light': '#3B82F6',
        'tech-blue-dark': '#1E40AF',
        'tech-purple': '#7C3AED',
        'tech-purple-light': '#A78BFA',
        'tech-purple-dark': '#5B21B6',
        'tech-cyan': '#06B6D4',
        'tech-bg': '#F8FAFC',
        'tech-surface': '#FFFFFF',
        'tech-border': '#E2E8F0',
        'tech-text': '#1E293B',
        'tech-muted': '#64748B',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
