const path = require('node:path');
module.exports = {
  content: [path.join(__dirname, 'src/components/assurapay/**/*.{ts,tsx}')],
  darkMode: ['class', '[data-theme="dark"]'],
  important: '#assurapay-landing',
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
