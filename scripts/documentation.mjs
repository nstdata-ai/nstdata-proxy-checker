import assert from 'node:assert/strict';
import { marked } from 'marked';

function literalWords(line) {
    const words = [];
    let remaining = line.trim();
    while (remaining) {
        const token = /^(?:"([^"\\$`\r\n]*)"|'([^'\r\n]*)'|([^\s"'\\$`;&|<>]+))(?=\s|$)/.exec(remaining);
        assert.ok(token, 'Documentation commands must use literal arguments without shell expansion or operators');
        words.push(token[1] ?? token[2] ?? token[3]);
        remaining = remaining.slice(token[0].length).trimStart();
    }
    assert.ok(words.length, 'Empty documentation command');
    return words;
}

function codeBlocks(text) {
    const blocks = [];
    marked.walkTokens(marked.lexer(text), token => { if (token.type === 'code') blocks.push(token); });
    return blocks;
}

export function shellCommands(text) {
    const commands = [];
    for (const block of codeBlocks(text).filter(token => token.lang === 'sh')) {
        let words = [];
        for (const line of block.text.trim().split('\n')) {
            const continued = line.trimEnd().endsWith('\\');
            if (continued) assert.match(line, /\s\\$/, 'Line continuation must follow a complete argument');
            words.push(...literalWords(continued ? line.trimEnd().slice(0, -1) : line));
            if (continued) continue;
            assert.ok(['npm', 'npx', 'node'].includes(words[0]), 'Unsupported documentation executable');
            commands.push(words);
            words = [];
        }
        assert.equal(words.length, 0, 'Unfinished documentation command continuation');
    }
    return commands;
}

export function javascriptExamples(text) {
    const examples = [];
    let program, filename;
    const blocks = [];
    marked.walkTokens(marked.lexer(text), token => {
        if (['paragraph', 'code'].includes(token.type)) blocks.push(token);
    });
    for (const block of blocks) {
        if (block.type === 'paragraph' && program === undefined) {
            const names = block.tokens.filter(token => token.type === 'codespan' && /^[a-z][a-z0-9-]*\.mjs$/.test(token.text));
            filename = names.length === 1 ? names[0].text : undefined;
        }
        if (block.lang === 'js') {
            assert.equal(program, undefined, 'JavaScript example needs a node command');
            assert.ok(filename, 'JavaScript example needs a preceding save filename');
            program = block.text;
        } else if (block.lang === 'sh') {
            const commands = shellCommands(block.raw);
            if (program !== undefined) {
                assert.equal(commands.length, 1, 'Each JavaScript example needs one node command');
                const [command] = commands;
                assert.equal(command.length, 2);
                assert.equal(command[0], 'node');
                assert.equal(command[1], filename, 'Save filename must match the node command');
                assert.match(command[1], /^[a-z][a-z0-9-]*\.mjs$/, 'Use a local .mjs example filename');
                assert.ok(!examples.some(example => example.filename === command[1]), 'Duplicate example filename');
                examples.push({ filename: command[1], code: program, command });
                program = undefined;
                filename = undefined;
            } else assert.ok(commands.every(command => command[0] !== 'node'), 'Node command has no example');
        }
    }
    assert.equal(program, undefined, 'JavaScript example needs a node command');
    return examples;
}

export function checkMarkdown(text, filename) {
    const headings = new Set();
    marked.walkTokens(marked.lexer(text), token => {
        if (token.type === 'text' && !token.tokens) assert.doesNotMatch(token.text, /\*\*/, `${filename}: unrendered emphasis`);
        if (token.type === 'code' && ['sh', 'js'].includes(token.lang)) {
            for (const line of token.text.split('\n')) assert.ok(line.length <= 100,
                `${filename}: ${line.length}-character ${token.lang} line needs scrolling`);
        }
        if (token.type === 'heading') {
            const id = token.text.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').replace(/ /g, '-');
            assert.ok(!headings.has(id), `${filename}: duplicate heading ${id}`);
            headings.add(id);
        }
    });
}
