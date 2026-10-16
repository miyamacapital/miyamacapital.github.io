// Shared Tailwind Play CDN config for the "lab" design.
// Load it right after https://cdn.tailwindcss.com on every page.
tailwind.config = {
  theme: {
    extend: {
      colors: {
        "lab-background": "#FCFCFD",
        "lab-section": "#F8FAFC",
        "lab-card": "#FFFFFF",
        "lab-text": "#0F172A",
        "lab-body": "#475569",
        "lab-muted": "#64748B",
        "lab-line": "#E2E8F0",
        "lab-outline": "#CBD5E1",
        "lab-accent": "#4F46E5",
        "lab-dark": "#0F172A",
        "lab-footer": "#0B1220",
        "lab-on-dark": "#CBD5E1",
        "lab-on-dark-muted": "#94A3B8",
        "lab-partial": "#F1F5F9",
        "lab-partial-text": "#334155",
        "lab-miss": "#FFF7ED",
        "lab-miss-text": "#9A3412",
        "lab-miss-outline": "#FED7AA",
        "lab-feature-label": "#A5B4FC",
        "lab-dark-line": "#1E293B",
      },
      fontFamily: {
        "lab-sans": ['"Inter"', '"Noto Sans TC"', '"Noto Sans CJK TC"', '"PingFang TC"', '"Microsoft JhengHei"', "sans-serif"],
        "lab-mono": ['"JetBrains Mono"', '"Noto Sans TC"', '"Noto Sans CJK TC"', "monospace"],
      },
      fontSize: {
        "lab-h1": "clamp(44px, 6.6vw, 88px)",
        "lab-h1-sub": "clamp(36px, 4.8vw, 60px)",
        "lab-h2": "clamp(26px, 2.8vw, 34px)",
      },
      lineHeight: { "lab-body": "1.65" },
      borderRadius: {
        "lab-button": "8px",
        "lab-card": "12px",
        "lab-feature": "16px",
        "lab-label": "999px",
      },
      maxWidth: { "lab-content": "1200px" },
      spacing: { "lab-gutter": "clamp(16px, 4vw, 48px)" },
    },
  },
};
