import js from '@eslint/js';

export default [
  { ignores: ['.tap/'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        Buffer: 'readonly',
        clearImmediate: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        process: 'readonly',
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
