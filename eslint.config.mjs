/* ESLint 9 flat config：不做风格警察，只抓真正会出事的写法。 */
export default [
  {
    ignores: ['dist/**', 'build/**', 'data/**', 'data-test*/**', '.pages/**', '**/.pages/**', '**/public/**', 'node_modules/**', 'tools/**']
  },
  {
    files: ['assets/**/*.js', 'cloudflare/**/*.js', 'scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
        navigator: 'readonly', location: 'readonly', fetch: 'readonly', crypto: 'readonly',
        Blob: 'readonly', URL: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
        AbortController: 'readonly', ReadableStream: 'readonly', Response: 'readonly', Headers: 'readonly',
        Request: 'readonly', DOMException: 'readonly', atob: 'readonly', btoa: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        console: 'readonly', process: 'readonly', Buffer: 'readonly', WebSocket: 'readonly', globalThis: 'readonly'
      }
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': 'off',
      'no-cond-assign': 'error',
      'no-constant-condition': 'off',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-func-assign': 'error',
      'no-unreachable': 'error',
      'no-unsafe-negation': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-self-assign': 'error',
      'no-shadow-restricted-names': 'error'
    }
  }
];
