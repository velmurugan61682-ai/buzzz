/** Tailwind is compiled at build time rather than loaded from the CDN:
 *  the CDN script ships the whole engine to every visitor, warns in the
 *  console, and cannot be versioned or cached properly. */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: { extend: {} },
  plugins: [],
};
