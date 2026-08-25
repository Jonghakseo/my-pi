((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EasyReviewMarkdown = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';

  const appendText = (nodes, value) => {
    if (!value) return;
    const previous = nodes.at(-1);
    if (previous?.type === 'text') previous.value += value;
    else nodes.push({ type: 'text', value });
  };

  const safeHref = (value) => {
    const href = value.trim();
    if (/^#[A-Za-z0-9_.:-]+$/.test(href)) return href;
    try {
      const parsed = new URL(href);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
      return null;
    }
  };

  const parseInline = (source) => {
    const text = String(source ?? '');
    const nodes = [];
    let index = 0;

    while (index < text.length) {
      if (text[index] === '\\' && index + 1 < text.length) {
        appendText(nodes, text[index + 1]);
        index += 2;
        continue;
      }

      if (text[index] === '`') {
        const end = text.indexOf('`', index + 1);
        if (end !== -1) {
          nodes.push({ type: 'code', value: text.slice(index + 1, end) });
          index = end + 1;
          continue;
        }
      }

      const strongMarker = text.startsWith('**', index)
        ? '**'
        : text.startsWith('__', index)
          ? '__'
          : null;
      if (strongMarker) {
        const end = text.indexOf(strongMarker, index + strongMarker.length);
        if (end > index + strongMarker.length) {
          nodes.push({
            type: 'strong',
            children: parseInline(text.slice(index + strongMarker.length, end)),
          });
          index = end + strongMarker.length;
          continue;
        }
      }

      const emphasisMarker = text[index] === '*' || text[index] === '_' ? text[index] : null;
      if (emphasisMarker) {
        const end = text.indexOf(emphasisMarker, index + 1);
        if (end > index + 1) {
          nodes.push({ type: 'emphasis', children: parseInline(text.slice(index + 1, end)) });
          index = end + 1;
          continue;
        }
      }

      if (text[index] === '[') {
        const labelEnd = text.indexOf('](', index + 1);
        const hrefEnd = labelEnd === -1 ? -1 : text.indexOf(')', labelEnd + 2);
        if (labelEnd !== -1 && hrefEnd !== -1) {
          const literal = text.slice(index, hrefEnd + 1);
          const href = safeHref(text.slice(labelEnd + 2, hrefEnd));
          if (href) {
            nodes.push({
              type: 'link',
              href,
              children: parseInline(text.slice(index + 1, labelEnd)),
            });
          } else {
            nodes.push({ type: 'text', value: literal });
          }
          index = hrefEnd + 1;
          continue;
        }
      }

      if (text[index] === '\n') {
        nodes.push({ type: 'break' });
        index += 1;
        continue;
      }

      appendText(nodes, text[index]);
      index += 1;
    }

    return nodes;
  };

  const isFence = (line) => /^ {0,3}```[A-Za-z0-9_-]*\s*$/.test(line);
  const isHeading = (line) => /^ {0,3}#{1,4}\s+/.test(line);
  const isUnorderedItem = (line) => /^\s*[-+*]\s+\S/.test(line);
  const isOrderedItem = (line) => /^\s*\d+\.\s+\S/.test(line);
  const isQuote = (line) => /^\s*>\s?/.test(line);
  const isRule = (line) => /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  const startsBlock = (line) =>
    !line.trim() ||
    isFence(line) ||
    isHeading(line) ||
    isUnorderedItem(line) ||
    isOrderedItem(line) ||
    isQuote(line) ||
    isRule(line);

  const parse = (source) => {
    const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^ {0,3}```([A-Za-z0-9_-]*)\s*$/);
      if (fence) {
        const body = [];
        index += 1;
        while (index < lines.length && !/^ {0,3}```\s*$/.test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        blocks.push({ type: 'code-block', language: fence[1], value: body.join('\n') });
        continue;
      }

      const heading = line.match(/^ {0,3}(#{1,4})\s+(.+)$/);
      if (heading) {
        blocks.push({
          type: 'heading',
          level: heading[1].length,
          children: parseInline(heading[2].trim()),
        });
        index += 1;
        continue;
      }

      if (isRule(line)) {
        blocks.push({ type: 'rule' });
        index += 1;
        continue;
      }

      if (isUnorderedItem(line) || isOrderedItem(line)) {
        const ordered = isOrderedItem(line);
        const pattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
        const items = [];
        while (index < lines.length) {
          const match = lines[index].match(pattern);
          if (!match) break;
          items.push(parseInline(match[1].trim()));
          index += 1;
        }
        blocks.push({ type: ordered ? 'ordered-list' : 'unordered-list', items });
        continue;
      }

      if (isQuote(line)) {
        const quoteLines = [];
        while (index < lines.length) {
          const match = lines[index].match(/^\s*>\s?(.*)$/);
          if (!match) break;
          quoteLines.push(match[1]);
          index += 1;
        }
        blocks.push({ type: 'blockquote', blocks: parse(quoteLines.join('\n')) });
        continue;
      }

      const paragraph = [line.trim()];
      index += 1;
      while (index < lines.length && !startsBlock(lines[index])) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    }

    return blocks;
  };

  const renderInline = (documentRef, parent, nodes) => {
    nodes.forEach((node) => {
      if (node.type === 'text') {
        parent.append(documentRef.createTextNode(node.value));
      } else if (node.type === 'break') {
        parent.append(documentRef.createElement('br'));
      } else if (node.type === 'code') {
        const code = documentRef.createElement('code');
        code.textContent = node.value;
        parent.append(code);
      } else if (node.type === 'strong' || node.type === 'emphasis') {
        const element = documentRef.createElement(node.type === 'strong' ? 'strong' : 'em');
        renderInline(documentRef, element, node.children);
        parent.append(element);
      } else if (node.type === 'link') {
        const link = documentRef.createElement('a');
        link.href = node.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        renderInline(documentRef, link, node.children);
        parent.append(link);
      }
    });
  };

  const renderBlocks = (documentRef, parent, blocks) => {
    blocks.forEach((block) => {
      if (block.type === 'paragraph' || block.type === 'heading') {
        const tag = block.type === 'paragraph' ? 'p' : `h${Math.min(block.level + 2, 6)}`;
        const element = documentRef.createElement(tag);
        renderInline(documentRef, element, block.children);
        parent.append(element);
      } else if (block.type === 'unordered-list' || block.type === 'ordered-list') {
        const list = documentRef.createElement(block.type === 'ordered-list' ? 'ol' : 'ul');
        block.items.forEach((item) => {
          const listItem = documentRef.createElement('li');
          renderInline(documentRef, listItem, item);
          list.append(listItem);
        });
        parent.append(list);
      } else if (block.type === 'code-block') {
        const pre = documentRef.createElement('pre');
        const code = documentRef.createElement('code');
        if (block.language) code.className = `language-${block.language}`;
        code.textContent = block.value;
        pre.append(code);
        parent.append(pre);
      } else if (block.type === 'blockquote') {
        const quote = documentRef.createElement('blockquote');
        renderBlocks(documentRef, quote, block.blocks);
        parent.append(quote);
      } else if (block.type === 'rule') {
        parent.append(documentRef.createElement('hr'));
      }
    });
  };

  const render = (container, source) => {
    const documentRef = container.ownerDocument || document;
    const fragment = documentRef.createDocumentFragment();
    renderBlocks(documentRef, fragment, parse(source));
    container.replaceChildren(fragment);
  };

  return { parse, render };
});
