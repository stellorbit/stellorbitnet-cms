/* global window, document, confirm, Node */
/* stellorbit CMS: ブロック単位の管理（移動・複製・削除・コピー・見出し配下の一括操作・取り消し） */
(function () {
  'use strict';

  const DRAG_TYPE = 'text/x-cms-block';
  const HISTORY_LIMIT = 30;

  let deps = null;
  let toolbar = null;
  let highlight = null;
  let dropLine = null;
  let activeBlock = null;
  let sectionMode = false;
  let dragging = false;
  let dropIndex = -1;
  let undoStack = [];
  let redoStack = [];

  const content = function () { return window.CmsContent; };

  /* ---------- 取り消し・やり直し ---------- */
  function resetHistory() {
    undoStack = [];
    redoStack = [];
    hide();
  }

  // 画像の操作ボタンは画面側で後から付け直すため、記録や複製には含めない
  function removeImageTools(element) {
    element.querySelectorAll('.figure-action-toolbar').forEach(function (el) { el.remove(); });
    [element].concat(Array.from(element.querySelectorAll('.is-selected'))).forEach(function (el) {
      el.classList.remove('is-selected');
      if (el.hasAttribute('class') && !el.classList.length) el.removeAttribute('class');
    });
  }

  // 描画済みのXポストは高さなどが後から変わるため、元の引用の形で記録する
  function snapshot() {
    return deps.canvas.innerHTML
      .replace(/<div[^>]*figure-action-toolbar[^>]*>(?:(?!<\/div>)[\s\S])*<\/div>/g, '')
      .replace(/ class="is-selected"/g, '')
      .replace(/ is-selected(?=[" ])/g, '')
      .replace(
        /<div[^>]*twitter-tweet-rendered[^>]*>\s*<iframe[^>]*data-tweet-id="(\d+)"[^>]*>\s*<\/iframe>\s*<\/div>/g,
        '<blockquote class="twitter-tweet" data-dnt="true" align="center"><a href="https://x.com/i/status/$1"></a></blockquote>'
      );
  }

  // DOMを直接操作する変更は、ブラウザ標準の取り消しが効かないため前後を記録する
  function runOp(mutator) {
    const before = snapshot();
    mutator();
    const after = snapshot();
    if (before === after) return;
    undoStack.push({ before: before, after: after });
    if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  }

  function rewriteHistory(oldHtml, newHtml) {
    undoStack.concat(redoStack).forEach(function (entry) {
      entry.before = entry.before.split(oldHtml).join(newHtml);
      entry.after = entry.after.split(oldHtml).join(newHtml);
    });
  }

  function restore(from, to, source, target) {
    const entry = source[source.length - 1];
    if (!entry || entry[from] !== snapshot()) return false;
    source.pop();
    target.push(entry);
    deps.canvas.innerHTML = entry[to];
    hide();
    deps.afterChange();
    return true;
  }

  function undoBlockOp() { return restore('after', 'before', undoStack, redoStack); }
  function redoBlockOp() { return restore('before', 'after', redoStack, undoStack); }

  /* ---------- ブロックの単位 ---------- */
  // 表示されない <script> <style> は直前のブロックと一体で扱う
  function getUnits() {
    const units = [];
    Array.from(deps.canvas.children).forEach(function (el) {
      if (units.length && /^(SCRIPT|STYLE)$/.test(el.tagName)) units[units.length - 1].push(el);
      else units.push([el]);
    });
    return units;
  }

  function indexOfBlock(units, block) {
    return units.findIndex(function (unit) { return unit.includes(block); });
  }

  // 見出しから、同じ階層以上の次の見出しの直前まで
  function getSectionRange(units, index) {
    const head = units[index][0];
    if (!content().isHeading(head)) return { start: index, count: 1 };
    const level = Number(head.tagName.slice(1));
    let end = index + 1;
    while (end < units.length) {
      const next = units[end][0];
      if (content().isHeading(next) && Number(next.tagName.slice(1)) <= level) break;
      end += 1;
    }
    return { start: index, count: end - index };
  }

  function selectedRange(units) {
    const index = indexOfBlock(units, activeBlock);
    if (index < 0) return null;
    return sectionMode ? getSectionRange(units, index) : { start: index, count: 1 };
  }

  function elementsOf(units, range) {
    return units.slice(range.start, range.start + range.count).flat();
  }

  function prepare() {
    content().wrapLooseInline(deps.canvas);
    const units = getUnits();
    const range = selectedRange(units);
    return range ? { units: units, range: range } : null;
  }

  /* ---------- 操作 ---------- */
  // targetIndex は「この番号のブロックの直前へ移動」を表す
  function moveRange(units, range, targetIndex) {
    if (targetIndex >= range.start && targetIndex <= range.start + range.count) return;
    const elements = elementsOf(units, range);
    const reference = targetIndex < units.length ? units[targetIndex][0] : null;
    runOp(function () {
      elements.forEach(function (el) { deps.canvas.insertBefore(el, reference); });
    });
    deps.afterChange();
  }

  function moveBlock(direction) {
    const state = prepare();
    if (!state) return;
    const units = state.units;
    const range = state.range;
    let target;
    if (direction < 0) {
      if (range.start === 0) return;
      target = range.start - 1;
      if (sectionMode && content().isHeading(activeBlock)) {
        // 章単位の移動では、直前の同階層以上の章をまとめて飛び越える
        const level = Number(activeBlock.tagName.slice(1));
        for (let i = range.start - 1; i >= 0; i--) {
          const head = units[i][0];
          if (content().isHeading(head) && Number(head.tagName.slice(1)) <= level) {
            target = i;
            break;
          }
        }
      }
    } else {
      const next = range.start + range.count;
      if (next >= units.length) return;
      const nextHead = units[next][0];
      // 上位の見出しは章ごと飛び越えず、その見出し1つ分だけ下へ移す
      const wholeSection = sectionMode && content().isHeading(nextHead) &&
        Number(nextHead.tagName.slice(1)) >= Number(activeBlock.tagName.slice(1));
      target = next + (wholeSection ? getSectionRange(units, next).count : 1);
    }
    moveRange(units, range, target);
    showFor(activeBlock);
    activeBlock.scrollIntoView({ block: 'nearest' });
  }

  function duplicateBlock() {
    const state = prepare();
    if (!state) return;
    const originals = elementsOf(state.units, state.range);
    const copies = originals.map(function (el) { return el.cloneNode(true); });
    copies.forEach(removeImageTools);
    window.CmsPaste.dedupeIds(copies);
    runOp(function () {
      originals[originals.length - 1].after.apply(originals[originals.length - 1], copies);
    });
    deps.afterChange();
    showFor(copies[0]);
  }

  function deleteBlock() {
    const state = prepare();
    if (!state) return;
    const targets = elementsOf(state.units, state.range);
    if (state.range.count > 1 && !confirm('この章の ' + state.range.count + ' ブロックを削除しますか？（Ctrl+Z で戻せます）')) return;
    runOp(function () {
      targets.forEach(function (el) { el.remove(); });
      if (!deps.canvas.children.length) deps.canvas.appendChild(content().createParagraph(document));
    });
    hide();
    deps.afterChange();
    deps.toast('削除しました（Ctrl+Z で戻せます）', '🗑️');
  }

  function copyBlock() {
    const state = prepare();
    if (!state) return;
    const holder = document.createElement('div');
    elementsOf(state.units, state.range).forEach(function (el) { holder.appendChild(el.cloneNode(true)); });
    const text = holder.textContent;
    const html = content().serializeElement(holder);
    const write = function (event) {
      event.preventDefault();
      event.stopPropagation();
      event.clipboardData.setData(window.CmsPaste.INTERNAL_TYPE, html);
      event.clipboardData.setData('text/html', html);
      event.clipboardData.setData('text/plain', text);
    };
    document.addEventListener('copy', write, { capture: true, once: true });
    const ok = document.execCommand('copy');
    document.removeEventListener('copy', write, { capture: true });
    deps.toast(ok ? '📋 ' + state.range.count + ' ブロックをコピーしました' : '⚠️ コピーできませんでした', '📋');
  }

  /* ---------- 操作パネル ---------- */
  function relativeRect(element) {
    const base = deps.container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top - base.top + deps.container.scrollTop,
      bottom: rect.bottom - base.top + deps.container.scrollTop,
      left: rect.left - base.left + deps.container.scrollLeft,
      width: rect.width,
    };
  }

  function drawHighlight() {
    const units = getUnits();
    const range = selectedRange(units);
    if (!range) return;
    const visible = elementsOf(units, range).filter(function (el) { return el.offsetHeight > 0; });
    if (!visible.length) return;
    const first = relativeRect(visible[0]);
    const last = relativeRect(visible[visible.length - 1]);
    const canvas = relativeRect(deps.canvas);
    // 本文の表示範囲からはみ出すと余分なスクロールが出るため、枠内に収める
    const top = Math.max(first.top - 4, canvas.top);
    const bottom = Math.min(last.bottom + 4, canvas.bottom);
    highlight.style.display = bottom > top ? 'block' : 'none';
    highlight.style.top = top + 'px';
    highlight.style.left = canvas.left + 8 + 'px';
    highlight.style.width = canvas.width - 16 + 'px';
    highlight.style.height = Math.max(0, bottom - top) + 'px';
  }

  function showFor(block) {
    if (!block || block.parentNode !== deps.canvas || deps.getMode() !== 'visual') return hide();
    if (block !== activeBlock) sectionMode = false;
    activeBlock = block;
    const isHeading = content().isHeading(block);
    const sectionButton = toolbar.querySelector('[data-action="section"]');
    sectionButton.hidden = !isHeading;
    sectionButton.setAttribute('aria-pressed', String(sectionMode));
    toolbar.querySelector('.cms-block-label').textContent = block.tagName.toLowerCase();
    toolbar.style.display = 'flex';
    const rect = relativeRect(block);
    const canvas = relativeRect(deps.canvas);
    const top = Math.min(Math.max(rect.top - toolbar.offsetHeight + 4, canvas.top), canvas.bottom - toolbar.offsetHeight);
    toolbar.style.top = Math.max(0, top) + 'px';
    toolbar.style.left = Math.max(0, canvas.left + canvas.width - toolbar.offsetWidth - 12) + 'px';
    drawHighlight();
    return undefined;
  }

  function hide() {
    if (!toolbar) return;
    toolbar.style.display = 'none';
    highlight.style.display = 'none';
    dropLine.style.display = 'none';
    activeBlock = null;
    sectionMode = false;
  }

  function blockFromNode(node) {
    let current = node;
    while (current && current.parentNode !== deps.canvas) current = current.parentNode;
    return current && current.nodeType === 1 ? current : null;
  }

  function createButton(action, label, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cms-block-btn';
    button.setAttribute('data-action', action);
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = label;
    return button;
  }

  function buildToolbar() {
    toolbar = document.createElement('div');
    toolbar.id = 'cms-block-toolbar';
    toolbar.className = 'cms-block-toolbar';
    const label = document.createElement('span');
    label.className = 'cms-block-label';
    const handle = createButton('drag', '⠿', 'ドラッグして移動');
    handle.draggable = true;
    toolbar.append(
      handle,
      label,
      createButton('section', '章全体', '見出し配下をまとめて操作する'),
      createButton('up', '↑', '上へ移動'),
      createButton('down', '↓', '下へ移動'),
      createButton('duplicate', '複製', '複製する'),
      createButton('copy', 'コピー', 'クリップボードへコピーする'),
      createButton('delete', '削除', '削除する')
    );
    highlight = document.createElement('div');
    highlight.className = 'cms-block-highlight';
    dropLine = document.createElement('div');
    dropLine.className = 'cms-block-dropline';
    deps.container.append(highlight, dropLine, toolbar);

    toolbar.addEventListener('mousedown', function (e) {
      if (!e.target.closest('[data-action="drag"]')) e.preventDefault();
    });
    toolbar.addEventListener('click', function (e) {
      const button = e.target.closest('button');
      if (!button) return;
      const action = button.getAttribute('data-action');
      if (action === 'section') {
        sectionMode = !sectionMode;
        showFor(activeBlock);
      } else if (action === 'up') moveBlock(-1);
      else if (action === 'down') moveBlock(1);
      else if (action === 'duplicate') duplicateBlock();
      else if (action === 'copy') copyBlock();
      else if (action === 'delete') deleteBlock();
    });
    handle.addEventListener('dragstart', dragBlock);
    handle.addEventListener('dragend', function () {
      dragging = false;
      dropLine.style.display = 'none';
    });
  }

  /* ---------- ドラッグ移動 ---------- */
  function dragBlock(e) {
    if (!activeBlock) return;
    dragging = true;
    dropIndex = -1;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, '1');
    e.dataTransfer.setDragImage(activeBlock, 20, 10);
  }

  function onDragOver(e) {
    if (!dragging) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const units = getUnits();
    const visible = units.map(function (unit, index) { return { el: unit[0], index: index }; })
      .filter(function (item) { return item.el.offsetHeight > 0; });
    const next = visible.find(function (item) {
      const rect = item.el.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2;
    });
    dropIndex = next ? next.index : units.length;
    if (!visible.length) return;
    const rect = relativeRect(next ? next.el : visible[visible.length - 1].el);
    const canvas = relativeRect(deps.canvas);
    dropLine.style.display = 'block';
    dropLine.style.top = (next ? rect.top - 5 : rect.bottom + 3) + 'px';
    dropLine.style.left = canvas.left + 12 + 'px';
    dropLine.style.width = canvas.width - 24 + 'px';
  }

  function onDrop(e) {
    if (!dragging) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    dragging = false;
    dropLine.style.display = 'none';
    const state = prepare();
    if (!state || dropIndex < 0) return;
    const block = activeBlock;
    moveRange(state.units, state.range, dropIndex);
    showFor(block);
  }

  function onKeyDown(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || deps.getMode() !== 'visual') return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    const key = e.key.toLowerCase();
    let handled = false;
    if (key === 'z' && !e.shiftKey) handled = undoBlockOp();
    else if (key === 'y' || (key === 'z' && e.shiftKey)) handled = redoBlockOp();
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /* ---------- 画像まわりの編集: 標準の処理で説明欄が壊れないようにする ---------- */
  function elementAt(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element && element !== deps.canvas && deps.canvas.contains(element) ? element : null;
  }

  function topBlockOf(element) {
    let current = element;
    while (current.parentElement !== deps.canvas) current = current.parentElement;
    return current;
  }

  function placeCaret(element, atEnd) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(!atEnd);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // 要素の先頭（backward）または末尾にカーソルがあり、その先に消せる文字や画像がない
  function atEdge(element, range, backward) {
    const rest = document.createRange();
    rest.selectNodeContents(element);
    if (backward) rest.setEnd(range.startContainer, range.startOffset);
    else rest.setStart(range.startContainer, range.startOffset);
    const fragment = rest.cloneContents();
    fragment.querySelectorAll('.figure-action-toolbar').forEach(function (el) { el.remove(); });
    return fragment.textContent.replace(/[\r\n\t]/g, '') === '' && !fragment.querySelector('img, br, iframe, video, table');
  }

  // 説明欄でのEnterは欄を増やさず、図の下の行へ移動する
  function moveBelow(block) {
    let next = block.nextElementSibling;
    if (!next || next.tagName !== 'P' || !content().isVisuallyBlank(next)) {
      next = content().createAutoParagraph(document);
      runOp(function () { block.after(next); });
    }
    placeCaret(next, false);
    deps.afterChange();
  }

  function guardFigureEdit(event) {
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const element = elementAt(range.startContainer);
    if (!element) return;
    const type = event.inputType;
    const isBreak = type === 'insertParagraph' || type === 'insertLineBreak';
    const backward = /^delete\w*Backward$/.test(type);
    const forward = /^delete\w*Forward$/.test(type);
    const caption = element.closest('figcaption');
    if (caption && deps.canvas.contains(caption)) {
      if (type === 'insertParagraph') {
        event.preventDefault();
        moveBelow(topBlockOf(caption));
      } else if (range.collapsed && ((backward && atEdge(caption, range, true)) || (forward && atEdge(caption, range, false)))) {
        event.preventDefault();
      }
      return;
    }
    const block = topBlockOf(element);
    // 使い始めた行は、空でも保存する
    if (isBreak) block.removeAttribute('data-cms-auto');
    if (!backward || !range.collapsed || !/^(P|H[1-6])$/.test(block.tagName)) return;
    const figure = block.previousElementSibling;
    if (!figure || figure.tagName !== 'FIGURE') return;
    const blank = content().isVisuallyBlank(block);
    if (!blank && !atEdge(block, range, true)) return;
    event.preventDefault();
    // 本文は説明欄へ結合しない。空行だけは削除する
    const next = block.nextElementSibling;
    if (!blank || !next) return;
    runOp(function () { block.remove(); });
    const target = figure.querySelector('figcaption');
    placeCaret(target || next, Boolean(target));
    deps.afterChange();
  }

  // 消し切った説明欄に残る<br>を除き、入力欄の案内を表示し直す
  function tidyCaption(event) {
    const selection = window.getSelection();
    if (event.isComposing || !selection.rangeCount) return;
    const element = elementAt(selection.getRangeAt(0).startContainer);
    const caption = element && element.closest('figcaption');
    if (!caption || caption.textContent !== '' || !caption.firstChild || caption.querySelector('img')) return;
    caption.textContent = '';
    placeCaret(caption, false);
  }

  function initBlockToolbar(options) {
    deps = options;
    buildToolbar();
    deps.canvas.addEventListener('beforeinput', guardFigureEdit);
    deps.canvas.addEventListener('input', tidyCaption);
    deps.canvas.addEventListener('mousemove', function (e) {
      // ボタンを押したままの移動（ドラッグ開始や文字選択）では対象を切り替えない
      if (e.buttons) return;
      const block = blockFromNode(e.target);
      if (!block || block === activeBlock) return;
      // パネルへ向かう途中（現在のブロックのすぐ上）では対象を切り替えない
      if (activeBlock && activeBlock.isConnected) {
        const top = activeBlock.getBoundingClientRect().top;
        if (e.clientY < top && e.clientY >= top - toolbar.offsetHeight) return;
      }
      showFor(block);
    });
    // 入力中は本文に重ならないよう隠す
    deps.canvas.addEventListener('input', hide);
    deps.container.addEventListener('mouseleave', function () { if (!dragging) hide(); });
    deps.container.addEventListener('dragover', onDragOver, true);
    deps.container.addEventListener('drop', onDrop, true);
    deps.canvas.addEventListener('scroll', function () { if (!dragging && activeBlock) showFor(activeBlock); });
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', onKeyDown, true);
  }

  window.CmsBlocks = {
    initBlockToolbar,
    resetHistory,
    runOp,
    rewriteHistory,
    hide,
  };
})();
