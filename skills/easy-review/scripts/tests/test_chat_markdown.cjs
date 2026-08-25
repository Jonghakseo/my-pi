const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const assetPath = join(__dirname, '../../assets/chat_markdown.js');
const markdown = require(assetPath);

test('parses common assistant markdown into structured nodes', () => {
  const blocks = markdown.parse([
    '현재 검토에서 **명백한 문제**는 없었습니다.',
    '',
    '- `gum` 키 연결',
    '- [근거](https://example.com/review)',
    '',
    '```ts',
    'const safe = true;',
    '```',
  ].join('\n'));

  assert.equal(blocks[0].type, 'paragraph');
  assert.deepEqual(blocks[0].children[1], {
    type: 'strong',
    children: [{ type: 'text', value: '명백한 문제' }],
  });
  assert.equal(blocks[1].type, 'unordered-list');
  assert.equal(blocks[1].items[0][0].type, 'code');
  assert.deepEqual(blocks[1].items[1][0], {
    type: 'link',
    href: 'https://example.com/review',
    children: [{ type: 'text', value: '근거' }],
  });
  assert.deepEqual(blocks[2], {
    type: 'code-block',
    language: 'ts',
    value: 'const safe = true;',
  });
});

test('keeps raw HTML as text and rejects unsafe link protocols', () => {
  const blocks = markdown.parse('<img src=x onerror=alert(1)> [열기](javascript:alert(1))');
  assert.equal(blocks[0].type, 'paragraph');
  assert.equal(blocks[0].children[0].value, '<img src=x onerror=alert(1)> ');
  assert.equal(blocks[0].children[1].type, 'text');
  assert.equal(blocks[0].children[1].value, '[열기](javascript:alert(1))');
});

test('renderer source does not use HTML injection APIs', () => {
  const source = readFileSync(assetPath, 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|document\.write/);
});
