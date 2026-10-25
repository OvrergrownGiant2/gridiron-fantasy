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
        display: ['var(--font-display)'],
        sans: ['var(--font-sans)'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Corner roundness follows the user's setting (--radius, 14px by default → md 6, lg 8, xl 12).
      borderRadius: { card: 'var(--radius)', md: 'calc(var(--radius) * 0.43)', lg: 'calc(var(--radius) * 0.57)', xl: 'calc(var(--radius) * 0.86)', '2xl': 'calc(var(--radius) * 1.14)' },
      keyframes: {
        pulseDot: { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
        bump: { '0%': { transform: 'scale(1)' }, '40%': { transform: 'scale(1.12)' }, '100%': { transform: 'scale(1)' } },
        slideUp: { from: { transform: 'translateY(8px)', opacity: 0 }, to: { transform: 'none', opacity: 1 } },
      },
      animation: { pulseDot: 'pulseDot 1.4s ease-in-out infinite', bump: 'bump .5s ease-out', slideUp: 'slideUp .18s ease-out' },
    },
  },
};
