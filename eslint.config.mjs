import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/out-tsc'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // Applications are deployable units. They may consume
            // shared libraries, but nothing may depend on an app.
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:lib'],
            },
            // Libraries may only build on other libraries.
            {
              sourceTag: 'type:lib',
              onlyDependOnLibsWithTags: ['type:lib'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {
      // Align ESLint with the compiler. `noUnusedParameters` is on in
      // tsconfig.base.json, and TypeScript already exempts parameters named
      // with a leading underscore — without this, the two tools disagree
      // about the same line.
      //
      // The convention earns its place in a Nest codebase: a handler
      // sometimes needs a parameter it never reads, because the DECORATOR is
      // the point. `@Body() _dto: CreateOrderDto` is what makes the global
      // ValidationPipe reject an unexpected body; delete the parameter and a
      // client can POST its own prices and have them silently dropped, which
      // looks identical to having them accepted.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
];
