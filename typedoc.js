module.exports = {
  mode: 'file',
  readme: './doc/index.md',
  readmeToc: require('./doc/toc.json'),
  out: '_site',
  theme: 'node_modules/@m-ld/typedoc-theme/bin/minimal',

  includes: './doc/includes',
  exclude: [
    './src/engine/**',
    './src/types/**',
    './src/ns/**',
    './src/ably/**',
    './src/memdown/**',
    './src/mqtt/**',
    './src/wrtc/**',
    './src/socket.io/**',
    './src/security/**'
  ],
  excludePrivate: true,
  excludeProtected: true,
  disableSources: true,
  includeVersion: true,
  stripInternal: true,

  categorizeByGroup: true,
  categoryOrder: [
    'Configuration',
    'API',
    'json-rql',
    'RDFJS',
    'Utility',
    '*',
    'Experimental'
  ]
};