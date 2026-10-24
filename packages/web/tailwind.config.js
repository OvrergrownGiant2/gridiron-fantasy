/** Design tokens live in src/styles.css as CSS variables; Tailwind maps to them. */
const v = (n) => `rgb(var(--${n}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), surface: v('surface'), raised: v('raised'), sunken: v('sunken'),
        ink: v('ink'), muted: v('muted'), faint: v('faint'), line: v('line'),
        accent: v('accent'), 'accent-ink': v('accent-ink'), turf: v('turf'),
        live: v('live'), good: v('good'), warn: v('warn'), bad: v('bad'), info: v('info'),
      },
      fontFamily: {
        display: ['"Barlow Condensed"', '"Arial Narrow"', 'system-ui', 'sans-serif'],
        sans: ['Archivo', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { card: '14px' },
      keyframes: {
        pulseDot: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
        bump: { '0%': { transform: 'scale(1)' }, '40%': { transform: 'scale(1.12)' }, '100%': { transform: 'scale(1)' } },
        slideUp: { from: { transform: 'translateY(8px)', opacity: 0 }, to: { transform: 'none', opacity: 1 } },
      },
      animation: { pulseDot: 'pulseDot 1.4s ease-in-out infinite', bump: 'bump .5s ease-out', slideUp: 'slideUp .18s ease-out' },
    },
  },
};
