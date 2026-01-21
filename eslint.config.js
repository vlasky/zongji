const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: {
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        clearImmediate: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        exports: 'readonly',
        module: 'readonly',
        process: 'readonly',
        require: 'readonly',
        setImmediate: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'comma-dangle': ['warn', 'only-multiline'],
      'eol-last': ['error'],
      'keyword-spacing': ['error', { before: true }],
      'no-console': 'off',
      'no-trailing-spaces': ['error', { skipBlankLines: true }],
      'no-unused-vars': 'warn',
      'no-var': 'warn',
      'quotes': ['warn', 'single', 'avoid-escape'],
      'semi': ['error', 'always'],
      'space-before-blocks': 'error',
    },
  },
];
