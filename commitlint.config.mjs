export default {
  extends: ['@commitlint/config-conventional'],
  parserPreset: {
    parserOpts: {
      // Allow the mandatory version prefix added by .husky/commit-msg:
      // "v1.0.77 — feat(sync): outbox retry".
      headerPattern:
        /^(?:v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\s+[—–-]\s+)?(\w+)(?:\(([\w$.*/ -]+)\))?!?:\s(.+)$/,
      headerCorrespondence: ['type', 'scope', 'subject'],
    },
  },
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
    'header-max-length': [2, 'always', 120],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
  },
}
