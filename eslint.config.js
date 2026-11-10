'use strict';
// countinghouse's style gate, the same five rules (countinghouse eslint.config.js),
// so code moving between the two repositories reads the same.
module.exports = [
  {
    ignores: ['node_modules/**', '**/node_modules/**', '.superpowers/**']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs'
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-template': 'error',
      'no-prototype-builtins': 'error'
    }
  }
];
