const { fontFamily } = require('tailwindcss/defaultTheme');

/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  content: [
    './pages/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
    './app/**/*.{js,jsx}',
    './src/**/*.{js,jsx}'
  ],
  prefix: '',
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px'
      }
    },
    extend: {
      fontFamily: {
        // One sans for everything. font-display is a legacy alias that
        // resolves to the same family at whatever weight the caller asks for.
        sans: ['var(--font-sans)', 'Manrope', ...fontFamily.sans],
        display: ['var(--font-sans)', 'Manrope', ...fontFamily.sans],
        mono: [
          'var(--font-mono)',
          'IBM Plex Mono',
          'SF Mono',
          ...fontFamily.mono
        ]
      },
      fontSize: {
        // Tightened scale. Body anchored at 14px (was 15) — better density
        // for a forms-and-tables app, still passes WCAG. Greek diacritics
        // need the extra line-height, so we keep ≥1.5.
        label: ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0.04em' }],
        body: ['0.875rem', { lineHeight: '1.55' }],
        title: ['0.9375rem', { lineHeight: '1.35', letterSpacing: '0' }],
        headline: [
          '1.25rem',
          { lineHeight: '1.3', letterSpacing: '-0.005em' }
        ],
        display: ['1.5rem', { lineHeight: '1.2', letterSpacing: '-0.01em' }],
        'display-lg': [
          '2rem',
          { lineHeight: '1.15', letterSpacing: '-0.015em' }
        ]
      },
      colors: {
        // shadcn/Radix role aliases (HSL via CSS vars). Existing component
        // code keeps working through these.
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        // Page surface. Renamed from `body` → `canvas` to avoid a
        // text-body class collision (text-body is also a fontSize utility).
        canvas: 'hsl(var(--canvas))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))'
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },

        // Named tokens from /DESIGN.md. Prefer these for new code.
        ink: 'var(--color-ink)',
        'ink-soft': 'var(--color-ink-soft)',
        'ink-muted': 'var(--color-ink-muted)',
        bone: 'var(--color-bone)',
        cream: 'var(--color-cream)',
        stone: 'var(--color-stone)',
        'stone-line': 'var(--color-stone-line)',
        marble: 'var(--color-marble)',
        sea: {
          DEFAULT: 'var(--color-sea)',
          deep: 'var(--color-sea-deep)',
          tint: 'var(--color-sea-tint)'
        },
        oxide: {
          DEFAULT: 'var(--color-oxide)',
          tint: 'var(--color-oxide-tint)'
        },
        olive: {
          DEFAULT: 'var(--color-olive)',
          tint: 'var(--color-olive-tint)'
        }
      },
      borderRadius: {
        sharp: '4px',
        sm: '8px',
        md: 'var(--radius)', /* 10px */
        lg: '12px',
        pill: '999px'
      },
      boxShadow: {
        floating: 'var(--shadow-floating)',
        modal: 'var(--shadow-modal)',
        toast: 'var(--shadow-toast)'
      },
      transitionTimingFunction: {
        'out-quart': 'var(--ease-out-quart)',
        'out-expo': 'var(--ease-out-expo)'
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)'
      },
      keyframes: {
        'accordion-down': {
          from: { height: 0 },
          to: { height: 'var(--radix-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: 0 }
        }
      },
      animation: {
        'accordion-down':
          'accordion-down 180ms cubic-bezier(0.165, 0.84, 0.44, 1)',
        'accordion-up':
          'accordion-up 180ms cubic-bezier(0.165, 0.84, 0.44, 1)'
      }
    }
  },
  plugins: [
    function ({ addUtilities }) {
      addUtilities({
        '.popover-content-width-same-as-its-trigger': {
          width: 'var(--radix-popover-trigger-width)',
          'max-height': 'var(--radix-popover-content-available-height)'
        },
        '.tabular-nums': {
          'font-variant-numeric': 'tabular-nums',
          'font-feature-settings': '"tnum" 1'
        }
      });
    },
    require('tailwindcss-animate')
  ]
};
