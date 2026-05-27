/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        sidebar: '#1a1f2e',
        'sidebar-hover': '#252b3d',
        'sidebar-active': '#2d3450',
        'app-bg': '#f5f6fa',
        accent: '#3b82f6',
      },
    },
  },
  plugins: [],
};
