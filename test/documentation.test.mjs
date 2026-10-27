import assert from 'node:assert/strict';
import fs from 'node:fs';
import { marked } from 'marked';
import { test } from 'node:test';
import { shellCommands, javascriptExamples, checkMarkdown } from '../scripts/documentation.mjs';

test('documentation commands preserve literal quoted arguments and command boundaries', () => {
    assert.deepEqual(shellCommands('```sh\nnpm install @nstdata-ai/proxy-checker\nnpx --no-install nstdata-proxy-checker --expected-text "Example Domain"\n```'), [
        ['npm', 'install', '@nstdata-ai/proxy-checker'],
        ['npx', '--no-install', 'nstdata-proxy-checker', '--expected-text', 'Example Domain'],
    ]);
    assert.deepEqual(shellCommands('> ```sh\n> npm install @nstdata-ai/proxy-checker\n> ```'), [['npm', 'install', '@nstdata-ai/proxy-checker']]);
    assert.deepEqual(shellCommands("```sh\nnpx --no-install nstdata-proxy-checker --expected-text 'Example Domain'\n```"), [
        ['npx', '--no-install', 'nstdata-proxy-checker', '--expected-text', 'Example Domain'],
    ]);
});

test('documentation commands reject unsupported syntax rather than skipping it', () => {
    for (const line of ['npm install $(command)', 'npm install `command`', 'npm install "${TOKEN}"',
        'npm install "unfinished', 'npm install a; command', 'npm install a && command', 'npm install a | command',
        'npm install a > output', 'npm install a\\ b', 'curl https://example.com/']) {
        assert.throws(() => shellCommands('```sh\n' + line + '\n```'));
    }
});

const documents = ['README.md', 'README_zh.md', 'CONTRIBUTING.md', 'CHANGELOG.md',
    'SECURITY.md', 'docs/guide.md', 'docs/guide_zh.md'];

test('public Markdown renders emphasis and keeps runnable code within readable lines', () => {
    for (const file of documents) {
        const text = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
        checkMarkdown(text, file);
    }
    const chinese = fs.readFileSync(new URL('../docs/guide_zh.md', import.meta.url), 'utf8');
    assert.ok(marked.parse(chinese).includes('<strong>正文与响应头未经脱敏且不可信。</strong>'));
});

test('documentation commands join literal continuations without changing quoted content', () => {
    assert.deepEqual(shellCommands('```sh\nnpx --no-install nstdata-proxy-checker \\\n  --target https://example.com/ \\\n  --expected-text "Example Domain"\n```'), [
        ['npx', '--no-install', 'nstdata-proxy-checker', '--target', 'https://example.com/',
            '--expected-text', 'Example Domain'],
    ]);
    for (const text of ['npx --expected-text "open \\\nclose"', "npx --expected-text 'open \\\nclose'", 'npm install package \\']) {
        assert.throws(() => shellCommands('```sh\n' + text + '\n```'));
    }
});

test('JavaScript examples are paired with the documented local node command', () => {
    const markdown = 'Save as `check.mjs`.\n\n```js\nconsole.log("example");\n```\n\n```sh\nnode check.mjs\n```';
    assert.deepEqual(javascriptExamples(markdown), [{ filename: 'check.mjs',
        code: 'console.log("example");', command: ['node', 'check.mjs'] }]);
    for (const invalid of [markdown.replace('`check.mjs`', '`wrong.mjs`'), markdown.replace('node check.mjs', 'npm test'),
        markdown.replace('check.mjs', '../check.mjs'), markdown.replace('node check.mjs', 'node check.mjs extra'),
        '```js\nconsole.log("example");\n```', '```sh\nnode orphan.mjs\n```']) {
        assert.throws(() => javascriptExamples(invalid));
    }
    for (const file of ['docs/guide.md', 'docs/guide_zh.md']) {
        assert.equal(javascriptExamples(fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')).length, 3);
    }
});

test('rendered Markdown rejects literal emphasis and duplicate headings', () => {
    assert.throws(() => checkMarkdown('**正文不可信。**交给调用方', 'fixture.md'), /unrendered emphasis/);
    assert.throws(() => checkMarkdown('# Repeated\n\n# Repeated\n', 'fixture.md'), /duplicate heading/);
    checkMarkdown('**正文不可信。** 交给调用方', 'fixture.md');
    checkMarkdown('- **Important** text\n', 'fixture.md');
    assert.throws(() => checkMarkdown('- **正文不可信。**交给调用方', 'fixture.md'), /unrendered emphasis/);
});
