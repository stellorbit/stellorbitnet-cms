/* global window, document, Node, URL, alert */
/* stellorbit CMS: 貼り付け・コピー・画像挿入 */
(function () {
  'use strict';

  const INTERNAL_TYPE = 'text/x-cms-blocks';
  const WIDGETS_SRC = 'https://platform.twitter.com/widgets.js';
  const HEADINGS = 'h1, h2, h3, h4, h5, h6';
  const TEXT_ONLY_HOSTS = HEADINGS + ', .callout-title, pre';
  const INLINE_HOSTS = '.callout, blockquote, figcaption, td, th';
  const ALLOWED_TAGS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'TABLE', 'THEAD',
    'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'FIGURE', 'FIGCAPTION', 'IMG', 'A', 'B', 'STRONG', 'I', 'EM',
    'U', 'S', 'DEL', 'BR', 'HR', 'SUP', 'SUB', 'MARK', 'SMALL', 'DIV', 'IFRAME', 'ASIDE', 'CITE',
  ]);
  const ALLOWED_ATTRS = {
    A: ['href', 'target', 'rel', 'class'],
    IMG: ['src', 'alt', 'loading'],
    TD: ['colspan', 'rowspan'],
    TH: ['colspan', 'rowspan'],
    OL: ['start'],
    H1: ['id'], H2: ['id'], H3: ['id'], H4: ['id'], H5: ['id'], H6: ['id'],
    DIV: ['class'], ASIDE: ['class'], FIGURE: ['class'], FIGCAPTION: ['class'], CODE: ['class'], STRONG: ['class'],
    PRE: ['class', 'data-language'],
    BLOCKQUOTE: ['class', 'data-dnt', 'align'],
    IFRAME: ['src', 'title', 'frameborder', 'allow', 'allowfullscreen'],
  };
  const SITE_CLASS = /^(blog-card[\w-]*|youtube-embed-wrapper|twitter-tweet|article-[\w-]+|language-[\w-]+|callout[\w-]*|table-wrapper|table-container|ai-notice[\w-]*)$/;
  const SAFE_LINK = /^(https?:|mailto:|\/(?!\/)|#)/i;
  const SAFE_IMAGE = /^(https?:\/\/|\/(?!\/)|data:image\/)/i;
  const YOUTUBE_EMBED = /^https:\/\/www\.youtube(-nocookie)?\.com\/embed\//i;

  const pending = new Set();
  let uploadQueue = Promise.resolve();
  let deps = null;
  let slotCounter = 0;

  const content = function () { return window.CmsContent; };
  const runOp = function (mutator) { window.CmsBlocks.runOp(mutator); };

  function currentRange() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return deps.canvas.contains(range.commonAncestorContainer) ? range : null;
  }

  function closestInCanvas(node, selector) {
    const element = node && node.nodeType === Node.ELEMENT_NODE ? node : node && node.parentElement;
    const found = element ? element.closest(selector) : null;
    return found && found !== deps.canvas && deps.canvas.contains(found) ? found : null;
  }

  function topLevelOf(node) {
    let current = node;
    while (current && current.parentNode !== deps.canvas) current = current.parentNode;
    return current;
  }

  function setCaret(container, offset) {
    const range = document.createRange();
    range.setStart(container, offset);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function dedupeIds(nodes) {
    const used = new Set(Array.from(deps.canvas.querySelectorAll('[id]'), function (el) { return el.id; }));
    nodes.forEach(function (node) {
      const targets = Array.from(node.querySelectorAll('[id]'));
      if (node.id) targets.unshift(node);
      targets.forEach(function (el) {
        let candidate = el.id;
        for (let i = 2; used.has(candidate); i++) candidate = el.id + '-' + i;
        el.id = candidate;
        used.add(candidate);
      });
    });
  }

  // Xの引用を含むのに読み込みスクリプトがない場合は補う
  function ensureTweetScript(nodes) {
    const quote = nodes.find(function (n) {
      return n.matches('blockquote.twitter-tweet') || n.querySelector('blockquote.twitter-tweet');
    });
    const hasScript = function (n) { return n.matches('script[src*="widgets.js"]') || n.querySelector('script[src*="widgets.js"]'); };
    if (!quote || nodes.some(hasScript) || deps.canvas.querySelector('script[src*="widgets.js"]')) return;
    const holder = document.createElement('template');
    holder.innerHTML = '<script async src="' + WIDGETS_SRC + '" charset="utf-8"></script>';
    nodes.splice(nodes.indexOf(quote) + 1, 0, document.importNode(holder.content.firstChild, true));
  }

  /* ---------- ブロック境界への挿入 ---------- */
  function insertBlocksAtCaret(nodes) {
    const canvas = deps.canvas;
    const range = currentRange();
    if (range && !range.collapsed) {
      range.deleteContents();
      range.collapse(true);
    }
    const container = range ? range.startContainer : null;
    const offset = range ? range.startOffset : 0;
    const reference = container === canvas ? canvas.childNodes[offset] || null : null;
    content().wrapLooseInline(canvas);

    let rest = null;
    const last = nodes[nodes.length - 1];
    const block = container && container !== canvas ? topLevelOf(container) : null;
    if (container === canvas) {
      const before = reference ? topLevelOf(reference) : null;
      nodes.forEach(function (n) { canvas.insertBefore(n, before); });
    } else if (!block) {
      canvas.append.apply(canvas, nodes);
    } else if (block.tagName === 'P') {
      const tail = document.createRange();
      tail.setStart(container, offset);
      tail.setEnd(block, block.childNodes.length);
      rest = block.cloneNode(false);
      rest.removeAttribute('id');
      rest.appendChild(tail.extractContents());
      block.after.apply(block, nodes);
      last.after(rest);
      if (content().isVisuallyBlank(block)) block.remove();
      if (content().isVisuallyBlank(rest)) {
        rest.remove();
        rest = null;
      }
    } else {
      const head = document.createRange();
      head.setStart(block, 0);
      head.setEnd(container, offset);
      if (content().isHeading(block) && head.toString() === '') {
        block.before.apply(block, nodes);
        setCaret(block, 0);
        return;
      }
      block.after.apply(block, nodes);
    }

    if (!rest) {
      const next = last.nextElementSibling;
      if (next && next.tagName === 'P' && content().isVisuallyBlank(next)) {
        rest = next;
      } else {
        rest = content().createParagraph(document);
        last.after(rest);
      }
    }
    setCaret(rest, 0);
  }

  function insertNodes(nodes) {
    if (!nodes.length) return;
    ensureTweetScript(nodes);
    dedupeIds(nodes);
    runOp(function () { insertBlocksAtCaret(nodes); });
    deps.afterInsert();
  }

  function importChildren(fragment) {
    return Array.from(fragment.children, function (child) { return document.importNode(child, true); });
  }

  // 埋め込みボタンなどが生成するHTMLをブロックとして挿入する
  function insertHtml(html) {
    const root = content().parseArticle(html).content;
    content().normalizeBlocks(root);
    while (root.lastElementChild && root.lastElementChild.tagName === 'P' && content().isVisuallyBlank(root.lastElementChild)) {
      root.lastElementChild.remove();
    }
    const hadCaret = Boolean(currentRange());
    deps.canvas.focus();
    // 本文にカーソルがなかった場合は、先頭ではなく末尾へ追加する
    if (!hadCaret) window.getSelection().removeAllRanges();
    insertNodes(importChildren(root));
  }

  // 画面のボタンが作った要素（表・コードなど）をブロックとして挿入する
  function insertElements(elements, range) {
    const inCanvas = Boolean(range) && deps.canvas.contains(range.commonAncestorContainer);
    deps.canvas.focus();
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (inCanvas) selection.addRange(range);
    insertNodes(elements);
  }

  function insertFragment(root) {
    const nodes = importChildren(root);
    const isInline = nodes.length === 1 && nodes[0].tagName === 'P' && !nodes[0].querySelector('img, iframe');
    const range = currentRange();
    if (isInline && range) {
      document.execCommand('insertHTML', false, nodes[0].innerHTML);
      return;
    }
    // リスト内では枠の外へ出さず、その場に挿入する
    if (range && closestInCanvas(range.startContainer, 'li')) {
      document.execCommand('insertHTML', false, nodes.map(function (n) { return n.outerHTML; }).join(''));
      deps.afterInsert();
      return;
    }
    insertNodes(nodes);
  }

  /* ---------- 外部HTMLの無害化 ---------- */
  function toSitePath(value) {
    try {
      const url = new URL(value);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      const ownPort = [window.location.port, '8322', '4321'].includes(url.port);
      return local && ownPort ? url.pathname + url.search + url.hash : value;
    } catch {
      return value;
    }
  }

  function unwrap(element) {
    while (element.firstChild) element.parentNode.insertBefore(element.firstChild, element);
    element.remove();
  }

  function rename(element, tag) {
    const next = element.ownerDocument.createElement(tag);
    while (element.firstChild) next.appendChild(element.firstChild);
    element.replaceWith(next);
    return next;
  }

  function applySpanStyle(span) {
    const style = span.style;
    const wrappers = [];
    if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600) wrappers.push('b');
    if (style.fontStyle === 'italic') wrappers.push('i');
    if (/underline/.test(style.textDecoration) && !span.closest('a')) wrappers.push('u');
    if (/line-through/.test(style.textDecoration)) wrappers.push('s');
    if (span.textContent.trim()) {
      wrappers.forEach(function (tag) {
        const wrapper = span.ownerDocument.createElement(tag);
        while (span.firstChild) wrapper.appendChild(span.firstChild);
        span.appendChild(wrapper);
      });
    }
    unwrap(span);
  }

  function filterAttributes(element) {
    const allowed = ALLOWED_ATTRS[element.tagName] || [];
    Array.from(element.attributes).forEach(function (attr) {
      if (!allowed.includes(attr.name)) element.removeAttribute(attr.name);
    });
    if (element.hasAttribute('class')) {
      const kept = element.getAttribute('class').split(/\s+/).filter(function (c) { return SITE_CLASS.test(c); });
      if (kept.length) element.setAttribute('class', kept.join(' '));
      else element.removeAttribute('class');
    }
  }

  function sanitizeElement(el, report) {
    const tag = el.tagName;
    if (tag === 'SPAN') return applySpanStyle(el);
    if ((tag === 'B' || tag === 'STRONG') && /^(normal|400)$/.test(el.style.fontWeight)) return unwrap(el);
    if (!ALLOWED_TAGS.has(tag)) return unwrap(el);
    if (tag === 'IMG') {
      const source = toSitePath(el.getAttribute('src') || '');
      const width = Number(el.getAttribute('width'));
      if (/emoji/i.test(el.className) || /twimg\.com\/emoji/.test(source) || (width > 0 && width <= 32)) {
        return el.replaceWith(el.getAttribute('alt') || '');
      }
      if (!SAFE_IMAGE.test(source)) {
        report.lost += 1;
        return el.remove();
      }
      el.setAttribute('src', source);
    }
    if (tag === 'A') {
      const href = toSitePath(el.getAttribute('href') || '');
      if (!SAFE_LINK.test(href)) return unwrap(el);
      el.setAttribute('href', href);
    }
    if (tag === 'IFRAME' && !YOUTUBE_EMBED.test(el.getAttribute('src') || '')) return el.remove();
    filterAttributes(el);
    if (tag === 'DIV' && !el.hasAttribute('class')) {
      const hasBlock = el.querySelector('p, div, ul, ol, table, pre, blockquote, figure, ' + HEADINGS);
      if (hasBlock || el.parentElement && el.parentElement.closest('li, td, th')) return unwrap(el);
      rename(el, 'p');
    }
    return undefined;
  }

  function sanitizePastedHtml(html) {
    const root = content().parseArticle(html).content;
    const report = { lost: 0 };
    root.querySelectorAll('iframe[data-tweet-id]').forEach(function (frame) {
      const quote = root.ownerDocument.createElement('blockquote');
      quote.className = 'twitter-tweet';
      const link = root.ownerDocument.createElement('a');
      link.setAttribute('href', 'https://x.com/i/status/' + frame.getAttribute('data-tweet-id').replace(/\D/g, ''));
      quote.appendChild(link);
      (frame.closest('.twitter-tweet-rendered') || frame).replaceWith(quote);
    });
    root.querySelectorAll(
      'script, style, meta, link, title, base, object, embed, form, input, button, select, textarea, noscript, template, svg'
    ).forEach(function (el) { el.remove(); });
    Array.from(root.childNodes).forEach(function (n) { if (n.nodeType === Node.COMMENT_NODE) n.remove(); });
    // 子から先に処理して、解除で親子関係が崩れないようにする
    Array.from(root.querySelectorAll('*')).reverse().forEach(function (el) { sanitizeElement(el, report); });
    content().normalizeBlocks(root);
    return { root: root, lost: report.lost };
  }

  // CMS内の「コピー」ボタン由来。書式は保ち、危険な属性だけ除く
  function scrubInternal(html) {
    const root = content().parseArticle(html).content;
    root.querySelectorAll('script').forEach(function (el) {
      if (el.getAttribute('src') !== WIDGETS_SRC) el.remove();
    });
    root.querySelectorAll('*').forEach(function (el) {
      Array.from(el.attributes).forEach(function (attr) {
        if (/^on/i.test(attr.name) || /^\s*javascript:/i.test(attr.value) || attr.name === 'srcdoc') {
          el.removeAttribute(attr.name);
        }
      });
    });
    return root;
  }

  /* ---------- 画像の挿入 ---------- */
  function createFigure(url, file) {
    const name = file.name || '';
    const figure = document.createElement('figure');
    figure.className = 'article-image-figure';
    const alt = /^image(\.\w+)?$/i.test(name) ? '' : name.replace(/\.[^/.]+$/, '')
      .replace(/[^a-zA-Z0-9_\u3000-\u30fe\u4e00-\u9fa5-]/g, ' ').trim();
    const img = document.createElement('img');
    img.setAttribute('src', url);
    img.setAttribute('alt', alt);
    const caption = document.createElement('figcaption');
    caption.className = 'article-image-caption';
    caption.setAttribute('contenteditable', 'true');
    caption.setAttribute('data-placeholder', content().CAPTION_PLACEHOLDER);
    figure.append(img, caption);
    return figure;
  }

  function reserveImageSlot() {
    const slot = document.createElement('p');
    slotCounter += 1;
    slot.setAttribute('data-cms-slot', 'slot-' + Date.now() + '-' + slotCounter);
    slot.setAttribute('contenteditable', 'false');
    slot.className = 'cms-upload-slot';
    slot.textContent = '⏳ 画像をアップロード中...';
    return slot;
  }

  // 画像は1枚ごとにコミットされるため、同時に送らず順番に処理する
  function upload(file, slug) {
    const task = uploadQueue.then(function () { return deps.uploadImage(file, slug); });
    uploadQueue = task.catch(function () {});
    return task;
  }

  async function uploadIntoSlot(file, slug, slotId, slotHtml) {
    const find = function () { return deps.canvas.querySelector('[data-cms-slot="' + slotId + '"]'); };
    try {
      const url = await upload(file, slug);
      const figure = createFigure(url, file);
      window.CmsBlocks.rewriteHistory(slotHtml, figure.outerHTML);
      const slot = find();
      if (slot) {
        slot.replaceWith(figure);
        deps.afterInsert();
        deps.toast('✅ WebP画像を保存し配置しました', '🖼️');
      }
    } catch (err) {
      window.CmsBlocks.rewriteHistory(slotHtml, '');
      const slot = find();
      if (slot) slot.remove();
      alert('画像のアップロードに失敗しました: ' + err.message);
    }
  }

  function insertImages(files) {
    const list = Array.from(files).filter(function (f) { return f.type.startsWith('image/'); });
    const slug = deps.currentSlug();
    if (!list.length || !slug) return Promise.resolve();
    deps.toast('⏳ 画像をWebPに変換・最適化中...', '🖼️');
    let job;
    if (deps.getMode() === 'visual') {
      const slots = list.map(reserveImageSlot);
      const entries = slots.map(function (slot) { return [slot.getAttribute('data-cms-slot'), slot.outerHTML]; });
      runOp(function () { insertBlocksAtCaret(slots); });
      job = (async function () {
        for (let i = 0; i < list.length; i++) await uploadIntoSlot(list[i], slug, entries[i][0], entries[i][1]);
      })();
    } else {
      job = (async function () {
        for (const file of list) {
          try {
            deps.insertSource(createFigure(await upload(file, slug), file).outerHTML);
          } catch (err) {
            alert('画像のアップロードに失敗しました: ' + err.message);
          }
        }
      })();
    }
    pending.add(job);
    job.finally(function () { pending.delete(job); });
    return job;
  }

  /* ---------- 貼り付け ---------- */
  function imageFilesOf(data) {
    const isImage = function (f) { return f && f.type && f.type.startsWith('image/'); };
    const files = Array.from(data.files || []).filter(isImage);
    if (files.length) return files;
    return Array.from(data.items || [])
      .filter(function (item) { return item.type.startsWith('image/'); })
      .map(function (item) { return item.getAsFile(); })
      .filter(Boolean);
  }

  function pasteAsText(host, text, files) {
    const isCode = host.tagName === 'PRE';
    const value = isCode ? text.replace(/\r\n?/g, '\n') : text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!value) {
      if (files.length) insertImages(files);
    } else if (isCode) {
      // 標準の挿入は改行を<br>に変えるため、テキストノードとして入れる
      runOp(function () {
        const range = currentRange();
        range.deleteContents();
        const node = document.createTextNode(value);
        range.insertNode(node);
        setCaret(node, node.length);
      });
    } else {
      document.execCommand('insertText', false, value);
    }
  }

  function insertPlainText(text) {
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    const range = currentRange();
    const block = range && range.startContainer !== deps.canvas ? topLevelOf(range.startContainer) : null;
    if (lines.length === 1 || (block && block.nodeType === Node.ELEMENT_NODE && block.tagName !== 'P')) {
      document.execCommand('insertText', false, lines.join('\n'));
      return;
    }
    insertNodes(lines.map(function (line) {
      if (!line.trim()) return content().createParagraph(document);
      const paragraph = document.createElement('p');
      paragraph.textContent = line;
      return paragraph;
    }));
  }

  // 囲み・引用・表のセルが分断されないよう、段落などは改行に置き換える
  function flattenToInline(root) {
    root.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li').forEach(function (block) {
      if (block !== root.lastElementChild) block.appendChild(document.createElement('br'));
      unwrap(block);
    });
    root.querySelectorAll('ul, ol').forEach(unwrap);
    return document.importNode(root, true);
  }

  // 標準の挿入は段落を分割することがあるため、カーソル位置へ直接入れる
  function insertInline(fragment) {
    const last = fragment.lastChild;
    if (!last) return;
    runOp(function () {
      const range = currentRange();
      range.deleteContents();
      range.insertNode(fragment);
      range.setStartAfter(last);
      range.collapse(true);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    deps.afterInsert();
  }

  function pasteInline(html, text, files) {
    if (html) {
      const result = sanitizePastedHtml(html);
      if (result.root.textContent.trim() !== '') return insertInline(flattenToInline(result.root));
    }
    if (files.length) return insertImages(files);
    if (text) {
      const fragment = document.createDocumentFragment();
      text.replace(/\r\n?/g, '\n').split('\n').forEach(function (line, index) {
        if (index) fragment.appendChild(document.createElement('br'));
        fragment.appendChild(document.createTextNode(line));
      });
      insertInline(fragment);
    }
    return undefined;
  }

  function handlePaste(e) {
    const data = e.clipboardData || window.clipboardData;
    if (!data) return;
    e.preventDefault();
    if (!deps.canvas.isContentEditable) return;
    const files = imageFilesOf(data);
    const internal = data.getData(INTERNAL_TYPE) || '';
    const html = data.getData('text/html') || '';
    const text = data.getData('text/plain') || '';
    const range = currentRange();
    const host = range ? closestInCanvas(range.startContainer, TEXT_ONLY_HOSTS) : null;
    if (host) return pasteAsText(host, text, files);
    if (internal) return insertFragment(scrubInternal(internal));
    const url = text.trim();
    if (!files.length && /^https?:\/\/[^\s]+$/i.test(url)) return deps.embedUrl(url);
    if (range && closestInCanvas(range.startContainer, INLINE_HOSTS)) return pasteInline(html, text, files);
    if (html) {
      const result = sanitizePastedHtml(html);
      const hasText = result.root.textContent.trim() !== '';
      const hasStructure = Boolean(result.root.querySelector('table, iframe, blockquote, hr'));
      // 画像1点のコピーは、外部URLのままにせずローカルへ保存する
      if (files.length && !hasText && !hasStructure) return insertImages(files);
      if (hasText || hasStructure || result.root.querySelector('img')) {
        insertFragment(result.root);
        if (result.lost) {
          deps.toast('⚠️ 画像' + result.lost + '件は取り込めません。画像を単体でコピーして貼り付けてください', '⚠️');
        }
        return undefined;
      }
    }
    if (files.length) return insertImages(files);
    if (text) return insertPlainText(text);
    return undefined;
  }

  /* ---------- コピー: 見出しの選択が隣の画像などを巻き込まないようにする ---------- */
  // 画像の操作ボタンの文字は、選択された本文とみなさない
  function selectedText(range) {
    const fragment = range.cloneContents();
    fragment.querySelectorAll('.figure-action-toolbar').forEach(function (el) { el.remove(); });
    return fragment.textContent.trim();
  }

  function handleCopy(e) {
    const range = currentRange();
    if (!range || range.collapsed) return;
    const startHeading = closestInCanvas(range.startContainer, HEADINGS);
    const endHeading = closestInCanvas(range.endContainer, HEADINGS);
    if (startHeading === endHeading) return;
    let heading = null;
    const clamped = range.cloneRange();
    if (startHeading) {
      const outside = range.cloneRange();
      outside.setStartAfter(startHeading);
      if (selectedText(outside) === '') {
        heading = startHeading;
        clamped.setEnd(heading, heading.childNodes.length);
      }
    }
    if (!heading && endHeading) {
      const outside = range.cloneRange();
      outside.setEndBefore(endHeading);
      if (selectedText(outside) === '') {
        heading = endHeading;
        clamped.setStart(heading, 0);
      }
    }
    if (!heading) return;
    e.preventDefault();
    const text = clamped.toString();
    e.clipboardData.setData('text/plain', text);
    if (text.trim() === heading.textContent.trim()) {
      const copy = heading.cloneNode(true);
      copy.querySelectorAll('img, figure, iframe').forEach(function (el) { el.remove(); });
      e.clipboardData.setData('text/html', copy.outerHTML);
    }
    if (e.type === 'cut') {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(clamped);
      document.execCommand('delete');
    }
  }

  function placeCaretFromPoint(x, y) {
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (range && deps.canvas.contains(range.startContainer)) setCaret(range.startContainer, range.startOffset);
  }

  function init(options) {
    deps = options;
    deps.canvas.addEventListener('paste', handlePaste);
    deps.canvas.addEventListener('copy', handleCopy);
    deps.canvas.addEventListener('cut', handleCopy);
  }

  window.CmsPaste = {
    INTERNAL_TYPE,
    init,
    insertHtml,
    insertElements,
    insertImages,
    dedupeIds,
    placeCaretFromPoint,
    hasPendingUploads: function () { return pending.size > 0; },
    waitForUploads: function () { return Promise.all(Array.from(pending)); },
  };
})();
