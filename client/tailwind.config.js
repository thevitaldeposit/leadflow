/** @type {import('tailwindcss').Config} */

// Every color token is backed by a CSS variable (defined in src/index.css as a
// space-separated "R G B" triple) and exposed to Tailwind through the
// `<alpha-value>` channel syntax. That means a single source of truth in CSS
// drives the whole palette AND every token still supports opacity modifiers
// (e.g. `bg-success/10`, `border-brand/30`). To re-theme the app, change the
// variables in index.css — nothing here needs to move.
const token = (name) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Surfaces (dark-navy elevation ramp) ──────────────────────────
        background: token('--color-background'), // app canvas — deepest navy
        surface: token('--color-surface'),       // cards / panels
        'surface-2': token('--color-surface-2'), // raised / hover / nested
        sidebar: token('--color-sidebar'),       // nav rail
        'sidebar-hover': token('--color-sidebar-hover'),
        'sidebar-active': token('--color-sidebar-active'),
        well: token('--color-well'),             // sunken: inputs, tracks, wells

        // ── Lines ────────────────────────────────────────────────────────
        divider: token('--color-divider'),       // hairline borders / dividers

        // ── Text ─────────────────────────────────────────────────────────
        content: token('--color-content'),       // primary text (near-white)
        muted: token('--color-muted'),           // secondary text
        subtle: token('--color-subtle'),         // tertiary / captions

        // ── Accents ──────────────────────────────────────────────────────
        brand: token('--color-brand'),           // primary blue: buttons + links
        'brand-hover': token('--color-brand-hover'),
        success: token('--color-success'),       // green: in-progress / done / paid
        warning: token('--color-warning'),       // amber: needs attention
        danger: token('--color-danger'),         // red: critical / destructive
        info: token('--color-info'),             // cyan: informational stages

        // ── Legacy aliases (so pre-token classes keep resolving) ─────────
        accent: token('--color-brand'),
        'app-bg': token('--color-background'),
      },
      // Bare `border` / `divide-y` / `ring` pick up theme-appropriate defaults.
      borderColor: { DEFAULT: token('--color-divider') },
      divideColor: { DEFAULT: token('--color-divider') },
      ringColor: { DEFAULT: token('--color-brand') },
    },
  },
  plugins: [],
};
