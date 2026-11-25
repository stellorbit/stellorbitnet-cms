/* global window, document, NodeFilter, Node */
/* stellorbit CMS: 記事本文の解析・正規化・直列化 */
(function () {
  'use strict';

  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'AUDIO', 'BLOCKQUOTE', 'DETAILS', 'DIALOG', 'DIV', 'DL',
    'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'IFRAME', 'IMG', 'LINK', 'MAIN', 'META', 'NAV', 'OL', 'P', 'PICTURE',
    'PRE', 'SCRIPT', 'SECTION', 'STYLE', 'TABLE', 'TEMPLATE', 'UL', 'VIDEO',
  ]);
  // 段落・見出しの中に置いてはいけない要素
  const LIFT_SELECTOR =
    'img, picture, figure, iframe, video, audio, table, pre, ul, ol, hr, blockquote, div, script';
  const BLANK_TEXT = /^[ \t\r\n\f]*$/;
  const INLINE_WRAPPERS = new Set(['A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'SPAN', 'MARK', 'SMALL']);
  const WIDGETS_SRC = 'https://platform.twitter.com/widgets.js';
  const CAPTION_PLACEHOLDER = 'キャプションを入力（任意）';
  const RASTER_DATA_URL = /^data:image\/(png|jpe?g|webp|bmp|avif);base64,/i;

  function isHeading(node) {
    return Boolean(node) && node.nodeType === Node.ELEMENT_NODE && /^H[1-6]$/.test(node.tagName);
  }

  function isBlockNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (BLOCK_TAGS.has(node.tagName) || node.tagName.includes('-')) return true;
    return Boolean(node.querySelector('div, p, figure, table, ul, ol, pre, blockquote, h1, h2, h3, h4, h5, h6'));
  }

  // ページ内リンクの飛び先になる要素は、空でも消さない
  function isAnchorTarget(element) {
    return element.hasAttribute('id') || element.hasAttribute('name');
  }

  // 改行(<br>)も画像もない完全な空要素
  function isHollow(element) {
    if (isAnchorTarget(element)) return false;
    return Array.from(element.childNodes).every(function (child) {
      if (child.nodeType === Node.TEXT_NODE) return BLANK_TEXT.test(child.nodeValue);
      if (child.nodeType === Node.COMMENT_NODE) return true;
      return INLINE_WRAPPERS.has(child.tagName) && isHollow(child);
    });
  }

  // 表示される文字も画像もない（<br>だけは空とみなす）
  function isVisuallyBlank(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.trim() === '';
    if (node.nodeType === Node.COMMENT_NODE) return true;
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === 'BR') return true;
      if (isAnchorTarget(node)) return false;
      if (!INLINE_WRAPPERS.has(node.tagName) && !/^(P|H[1-6])$/.test(node.tagName)) return false;
    }
    return Array.from(node.childNodes).every(isVisuallyBlank);
  }

  function createParagraph(doc) {
    const paragraph = doc.createElement('p');
    paragraph.appendChild(doc.createElement('br'));
    return paragraph;
  }

  // カーソルを置くために自動で作る行。何も入力されなければ保存しない
  function createAutoParagraph(doc) {
    const paragraph = createParagraph(doc);
    paragraph.setAttribute('data-cms-auto', '');
    return paragraph;
  }

  function unwrap(element) {
    while (element.firstChild) element.parentNode.insertBefore(element.firstChild, element);
    element.remove();
  }

  function parseArticle(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    return template;
  }

  /* ---------- 書式の整理（旧 cleanArticleHtml の処理） ---------- */
  function cleanTree(root) {
    root.querySelectorAll('font').forEach(unwrap);
    root.querySelectorAll('[style]').forEach(function (el) {
      const style = el.style;
      if (!style) return;
      // 見出し・段落の文字サイズや書体の不揃いを防ぐ
      style.removeProperty('font-size');
      style.removeProperty('font-family');
      style.removeProperty('line-height');
      if (style.width && !style.width.endsWith('%')) style.removeProperty('width');
      if (style.minWidth) style.removeProperty('min-width');
      if (style.position === 'absolute' || style.position === 'fixed') style.removeProperty('position');
      if (style.color && /(white|#fff|#ffffff|rgb\(\s*255,\s*255,\s*255\))/i.test(style.color)) {
        style.removeProperty('color');
      }
      if (style.backgroundColor && /(black|#000|#0f172a|#0b1120)/i.test(style.backgroundColor)) {
        style.removeProperty('background-color');
      }
      if (!style.cssText.trim()) el.removeAttribute('style');
    });
    ['b, strong', 'i, em', 'u', 's, del'].forEach(function (selector) {
      root.querySelectorAll(selector).forEach(function (tag) {
        tag.querySelectorAll(selector).forEach(unwrap);
      });
    });
    root.querySelectorAll('span').forEach(function (span) {
      if (span.attributes.length === 0) unwrap(span);
    });
  }

  /* ---------- エディタ上でだけ必要な情報の除去 ---------- */
  function restoreTweets(root) {
    const doc = root.ownerDocument || document;
    root.querySelectorAll('iframe[data-tweet-id]').forEach(function (frame) {
      const tweetId = frame.getAttribute('data-tweet-id');
      if (!/^\d+$/.test(tweetId)) return;
      const target = frame.closest('.twitter-tweet-rendered') || frame;
      const quote = doc.createElement('blockquote');
      quote.className = 'twitter-tweet';
      quote.setAttribute('data-dnt', 'true');
      quote.setAttribute('align', 'center');
      const link = doc.createElement('a');
      link.setAttribute('href', 'https://x.com/i/status/' + tweetId);
      quote.appendChild(link);
      target.replaceWith(quote);
      if (!root.querySelector('script[src*="widgets.js"]')) {
        const script = doc.createElement('script');
        script.setAttribute('async', '');
        script.setAttribute('src', WIDGETS_SRC);
        script.setAttribute('charset', 'utf-8');
        quote.after(script);
      }
    });
  }

  function stripEditorArtifacts(root) {
    const doc = root.ownerDocument || document;
    // アップロード中の仮枠、画像の操作ボタン、選択状態は保存しない
    root.querySelectorAll('[data-cms-slot], .figure-action-toolbar').forEach(function (el) { el.remove(); });
    root.querySelectorAll('.is-selected').forEach(function (el) {
      el.classList.remove('is-selected');
      if (!el.classList.length) el.removeAttribute('class');
    });
    restoreTweets(root);
    root.querySelectorAll('[data-cms-auto]').forEach(function (el) {
      if (el.textContent.trim() === '' && !el.querySelector('img, iframe, table, pre')) el.remove();
      else el.removeAttribute('data-cms-auto');
    });
    root.querySelectorAll('[contenteditable]').forEach(function (el) { el.removeAttribute('contenteditable'); });
    root.querySelectorAll('[data-placeholder]').forEach(function (el) { el.removeAttribute('data-placeholder'); });
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    const fragments = [];
    while (walker.nextNode()) {
      if (/^(Start|End)Fragment$/.test(walker.currentNode.nodeValue.trim())) fragments.push(walker.currentNode);
    }
    fragments.forEach(function (comment) { comment.remove(); });
  }

  /* ---------- ブロック構造の正規化 ---------- */
  function isPlainDiv(node) {
    return node.nodeType === Node.ELEMENT_NODE && node.tagName === 'DIV' && !node.attributes.length;
  }

  // 属性のない直下の <div> は段落にするか解除する
  function unwrapPlainDivs(root) {
    const doc = root.ownerDocument || document;
    let target = Array.from(root.childNodes).find(isPlainDiv);
    while (target) {
      if (Array.from(target.childNodes).some(isBlockNode)) {
        unwrap(target);
      } else {
        const paragraph = doc.createElement('p');
        while (target.firstChild) paragraph.appendChild(target.firstChild);
        target.replaceWith(paragraph);
      }
      target = Array.from(root.childNodes).find(isPlainDiv);
    }
  }

  // 直下の裸テキストやインライン要素を段落にまとめる
  function wrapLooseInline(root) {
    const doc = root.ownerDocument || document;
    let run = [];
    function flush() {
      while (run.length && run[0].nodeType === Node.TEXT_NODE && BLANK_TEXT.test(run[0].nodeValue)) run.shift();
      while (run.length) {
        const last = run[run.length - 1];
        if (last.nodeType === Node.TEXT_NODE && BLANK_TEXT.test(last.nodeValue)) run.pop();
        else break;
      }
      if (run.length) {
        const paragraph = doc.createElement('p');
        root.insertBefore(paragraph, run[0]);
        run.forEach(function (node) { paragraph.appendChild(node); });
      }
      run = [];
    }
    Array.from(root.childNodes).forEach(function (node) {
      if (node.nodeType === Node.COMMENT_NODE || isBlockNode(node)) flush();
      else run.push(node);
    });
    flush();
  }

  function findLiftTargets(block) {
    const found = Array.from(block.querySelectorAll(LIFT_SELECTOR)).filter(function (el) {
      if (el.tagName === 'IMG' && /emoji/i.test(el.className)) return false;
      const outer = el.parentElement.closest(LIFT_SELECTOR);
      return !outer || outer === block || !block.contains(outer);
    });
    return found.map(function (el) {
      let target = el;
      // 画像だけを包むリンクや装飾タグは一緒に移動する
      while (target.parentElement !== block) {
        const parent = target.parentElement;
        const alone = Array.from(parent.childNodes).every(function (n) { return n === target || isVisuallyBlank(n); });
        if (!alone) break;
        target = parent;
      }
      return target;
    });
  }

  function isImageNode(node) {
    return node.tagName === 'IMG' || (!BLOCK_TAGS.has(node.tagName) && Boolean(node.querySelector('img')));
  }

  // 画像は段落で包む（figureにすると公開側で横幅いっぱいに引き伸ばされる）
  function asBlock(node) {
    if (!isImageNode(node)) return node;
    const paragraph = node.ownerDocument.createElement('p');
    paragraph.appendChild(node);
    return paragraph;
  }

  function splitParagraph(paragraph) {
    const doc = paragraph.ownerDocument;
    let current = paragraph;
    let anchor = paragraph;
    const targets = findLiftTargets(paragraph);
    // 画像だけの段落は、そのままで問題ないため変更しない
    if (paragraph.textContent.trim() === '' && targets.every(isImageNode)) return;
    targets.forEach(function (target) {
      if (!current.contains(target)) return;
      const range = doc.createRange();
      range.setStartAfter(target);
      range.setEnd(current, current.childNodes.length);
      const rest = current.cloneNode(false);
      rest.removeAttribute('id');
      rest.appendChild(range.extractContents());
      const block = asBlock(target);
      anchor.after(block);
      block.after(rest);
      if (isVisuallyBlank(current)) current.remove();
      current = rest;
      anchor = rest;
    });
    if (current !== paragraph && isVisuallyBlank(current)) current.remove();
  }

  // 見出しから画像などを外へ出す。後ろに続く文章は、並び順を保つため段落にする
  function liftFromHeading(heading) {
    const doc = heading.ownerDocument;
    const targets = findLiftTargets(heading);
    let current = heading;
    targets.forEach(function (target) {
      if (!current.contains(target)) return;
      const head = doc.createRange();
      head.setStart(current, 0);
      head.setEndBefore(target);
      const textBefore = head.toString().trim() !== '';
      const tail = doc.createRange();
      tail.setStartAfter(target);
      tail.setEnd(current, current.childNodes.length);
      const rest = tail.extractContents();
      const block = asBlock(target);
      if (!textBefore) {
        current.before(block);
        current.appendChild(rest);
        return;
      }
      current.after(block);
      if (rest.textContent.trim() === '') {
        current.appendChild(rest);
        return;
      }
      current = doc.createElement('p');
      current.appendChild(rest);
      block.after(current);
    });
    return targets.length;
  }

  // 見出しに直接入った改行は、2行目以降を段落に分ける
  function splitHeadingLines(heading) {
    const children = Array.from(heading.childNodes);
    if (!children.some(function (n) { return n.nodeName === 'BR'; })) return;
    const doc = heading.ownerDocument;
    const lines = [[]];
    children.forEach(function (child) {
      if (child.nodeName === 'BR') lines.push([]);
      else lines[lines.length - 1].push(child);
    });
    const fragment = doc.createDocumentFragment();
    let headingUsed = false;
    lines.forEach(function (nodes) {
      if (!nodes.some(function (n) { return (n.textContent || '').trim(); })) {
        fragment.appendChild(createParagraph(doc));
        return;
      }
      const element = headingUsed ? doc.createElement('p') : heading.cloneNode(false);
      headingUsed = true;
      nodes.forEach(function (n) { element.appendChild(n); });
      fragment.appendChild(element);
    });
    heading.replaceWith(fragment);
  }

  /* ---------- 図の修復（旧CMSで保存された本文向け） ---------- */
  function captionsOf(figure) {
    return Array.from(figure.children).filter(function (el) { return el.tagName === 'FIGCAPTION'; });
  }

  function isEmptyCaption(caption) {
    return caption.textContent.trim() === '' && !caption.querySelector('img, iframe');
  }

  // 説明欄が複数ある図は、文章を保ったまま1つにまとめる
  function mergeCaptions(figure) {
    const captions = captionsOf(figure);
    const filled = captions.filter(function (c) { return !isEmptyCaption(c); });
    const kept = filled[0] || captions[0];
    captions.forEach(function (caption) {
      if (caption === kept) return;
      if (!isEmptyCaption(caption)) {
        kept.appendChild(kept.ownerDocument.createElement('br'));
        while (caption.firstChild) kept.appendChild(caption.firstChild);
      }
      caption.remove();
    });
    if (kept && isEmptyCaption(kept)) kept.textContent = '';
  }

  // 画像を持たない外側の図が図を包んでいる場合は、外側を解除する
  function unwrapOuterFigure(figure) {
    const inner = Array.from(figure.querySelectorAll('figure'));
    const ownImage = Array.from(figure.querySelectorAll('img')).some(function (img) { return img.closest('figure') === figure; });
    const filled = captionsOf(figure).filter(function (c) { return !isEmptyCaption(c); });
    const onlyWraps = Array.from(figure.childNodes).every(function (node) {
      return node.nodeName === 'FIGURE' || node.nodeName === 'FIGCAPTION' || isVisuallyBlank(node);
    });
    // 複数の図と共通の説明を持つ組み合わせは、意図した構造なので残す
    if (!inner.length || ownImage || !onlyWraps || (inner.length > 1 && filled.length)) return;
    filled.forEach(function (caption) {
      const target = captionsOf(inner[0]).find(isEmptyCaption);
      if (target) target.replaceWith(caption);
      else inner[0].appendChild(caption);
      mergeCaptions(inner[0]);
    });
    Array.from(figure.children).forEach(function (child) {
      if (child.tagName === 'FIGURE') figure.before(child);
    });
    figure.remove();
  }

  function repairFigures(root) {
    Array.from(root.querySelectorAll('figure')).reverse().forEach(function (figure) {
      mergeCaptions(figure);
      unwrapOuterFigure(figure);
    });
  }

  function isFigureBlock(node) {
    if (!node) return false;
    if (node.tagName === 'FIGURE') return true;
    return node.tagName === 'P' && node.textContent.trim() === '' && Boolean(node.querySelector('img'));
  }

  // 見出しと画像の間に残った空行を詰める（読み込み時のみ）
  function closeFigureGaps(root) {
    let previous = null;
    let gap = [];
    Array.from(root.children).forEach(function (el) {
      if (el.tagName === 'P' && isVisuallyBlank(el) && !isAnchorTarget(el)) {
        gap.push(el);
        return;
      }
      if ((isHeading(previous) && isFigureBlock(el)) || (isFigureBlock(previous) && isHeading(el))) {
        gap.forEach(function (p) { p.remove(); });
      }
      previous = el;
      gap = [];
    });
  }

  function normalizeBlocks(root) {
    repairFigures(root);
    unwrapPlainDivs(root);
    wrapLooseInline(root);
    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(function (heading) {
      liftFromHeading(heading);
      heading.querySelectorAll('p, div').forEach(unwrap);
      if (isVisuallyBlank(heading)) heading.remove();
      else splitHeadingLines(heading);
    });
    Array.from(root.children).forEach(function (el) {
      if (el.tagName !== 'P') return;
      splitParagraph(el);
    });
    Array.from(root.children).forEach(function (el) {
      if (el.tagName === 'P' && isHollow(el)) el.remove();
    });
  }

  /* ---------- 直列化 ---------- */
  function escapeBraces(root) {
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (parent && /^(SCRIPT|STYLE)$/.test(parent.tagName)) continue;
      node.nodeValue = node.nodeValue.replace(/\{/g, '\uE000').replace(/\}/g, '\uE001');
    }
  }

  function serializeFragment(root, options) {
    stripEditorArtifacts(root);
    cleanTree(root);
    normalizeBlocks(root);
    if (options && options.closeFigureGaps) closeFigureGaps(root);
    while (root.lastElementChild && root.lastElementChild.tagName === 'P' && isVisuallyBlank(root.lastElementChild)) {
      root.lastElementChild.remove();
    }
    escapeBraces(root);
    // <pre>直後の改行は解析時に1つ消えるため補う
    root.querySelectorAll('pre').forEach(function (pre) {
      const first = pre.firstChild;
      if (first && first.nodeType === Node.TEXT_NODE && first.nodeValue.startsWith('\n')) {
        first.nodeValue = '\n' + first.nodeValue;
      }
    });
    const parts = [];
    root.childNodes.forEach(function (node) {
      if (node.nodeType === Node.ELEMENT_NODE) parts.push(node.outerHTML);
      else if (node.nodeType === Node.COMMENT_NODE) parts.push('<!--' + node.nodeValue + '-->');
    });
    if (!parts.length) return '';
    return parts.join('\n')
      .replace(/ is:inline=""/g, ' is:inline')
      .replace(/\uE000/g, '&#123;')
      .replace(/\uE001/g, '&#125;') + '\n';
  }

  function cleanHtml(html, options) {
    return serializeFragment(parseArticle(html).content, options);
  }

  function serializeElement(element) {
    const template = document.createElement('template');
    const doc = template.content.ownerDocument;
    element.childNodes.forEach(function (child) { template.content.appendChild(doc.importNode(child, true)); });
    return serializeFragment(template.content);
  }

  // ビジュアル編集すると壊れる記法（Astro固有）を検出する
  function detectSourceOnly(raw) {
    const source = String(raw || '');
    if (/^\uFEFF?\s*---\r?\n/.test(source)) return 'frontmatter';
    const body = source
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b(?:"[^"]*"|'[^']*'|[^'">])*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, '');
    if (/<\/?[A-Z][\w.]*[\s/>]/.test(body) || /<\/?>/.test(body)) return 'コンポーネント';
    const tagPattern = /<\/?[a-zA-Z](?:"[^"]*"|'[^']*'|\{[^{}]*\}|[^'"<>{}])*>/g;
    const tags = (body.match(tagPattern) || []).map(function (tag) { return tag.replace(/"[^"]*"|'[^']*'/g, '""'); });
    if (tags.some(function (tag) { return /=\s*\{|\sset:(html|text)|\sclass:list/.test(tag); })) return 'Astroの式';
    if (/[{}]/.test(body.replace(tagPattern, ''))) return 'Astroの式';
    const selfClosing = /<(?!(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b)[a-z][\w:-]*(?:"[^"]*"|'[^']*'|[^'"<>])*\/>/;
    if (selfClosing.test(body)) return '自己終了タグ';
    return null;
  }

  async function uploadEmbeddedImages(root, upload) {
    const images = Array.from(root.querySelectorAll('img')).filter(function (img) {
      return RASTER_DATA_URL.test(img.getAttribute('src') || '');
    });
    const uploaded = new Map();
    for (const img of images) {
      const source = img.getAttribute('src');
      if (!uploaded.has(source)) uploaded.set(source, await upload(source, 'embedded.png'));
      img.setAttribute('src', uploaded.get(source));
    }
    return images.length;
  }

  function decorateForEditor(canvas) {
    canvas.querySelectorAll('figcaption').forEach(function (caption) {
      caption.setAttribute('contenteditable', 'true');
      caption.setAttribute('data-placeholder', CAPTION_PLACEHOLDER);
    });
    const last = canvas.lastElementChild;
    if (!last || !/^(P|H[1-6])$/.test(last.tagName)) canvas.appendChild(createParagraph(document));
  }

  window.CmsContent = {
    CAPTION_PLACEHOLDER,
    isHeading,
    isVisuallyBlank,
    createParagraph,
    createAutoParagraph,
    parseArticle,
    wrapLooseInline,
    liftFromHeading,
    normalizeBlocks,
    cleanHtml,
    serializeElement,
    detectSourceOnly,
    uploadEmbeddedImages,
    decorateForEditor,
  };
})();
