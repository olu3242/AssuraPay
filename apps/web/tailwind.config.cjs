const path = require('node:path');

module.exports = {
  content: [path.join(__dirname, 'src/components/landing/**/*.tsx')],
  important: '#assurapay-landing',
  corePlugins: { preflight: false },
  theme: { extend: {} },
  plugins: [],
};
