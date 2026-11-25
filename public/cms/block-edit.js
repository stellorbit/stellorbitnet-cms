/* global window, document, confirm, Node */
/* stellorbit CMS: ブロック内の対象選択・種類変更・ID指定・ブロック追加 */
(function () {
  'use strict';

  const TARGETS = 'h1, h2, h3, h4, p';
  // 種類を変えると構造が崩れる場所の中は対象にしない
  const EXCLUDED = 'figure, table, pre, li, .blog-card-wrapper, .blog-card, .youtube-embed-wrapper, ' +
    'blockquote.twitter-tweet, [data-cms-slot]';
  const INVALID_ID = /[\s"'<>{}#&]/;
  const TYPES = [['p', '段落'], ['h2', '見出し2'], ['h3', '見出し3'], ['h4', '見出し4']];
  const LABEL_LENGTH = 16;
  const KINDS = [
    ['p', '段落'], ['h2', '見出し2'], ['h3', '見出し3'], ['h4', '見出し4'], ['ul', '箇条書き'], ['ol', '番号付き'],
    ['quote', '引用'], ['callout', '囲み'], ['table', '表'], ['code', 'コード'], ['image', '画像'],
    ['media', 'メディア'], ['embed', '埋め込み'],
  ];

  let deps = null;
  let row = null;
  let targetSelect = null;
  let typeSelect = null;
  let idInput = null;
  let menu = null;
  let outline = null;
  let targets = [];
  let target = null;
  let blocks = [];
  let addPosition = 'after';

  const content = function () { return window.CmsContent; };

  /* ---------- 対象 ---------- */
  function isTarget(element) {
    return element.matches(TARGETS) && !element.closest(EXCLUDED);
  }

  function listTargets(elements) {
    return elements.flatMap(function (el) {
      const inner = Array.from(el.querySelectorAll(TARGETS));
      return [el].concat(inner).filter(isTarget);
    });
  }

  // カーソル位置などから、対象となる見出し・段落を探す
  function targetAt(node) {
    let current = node && node.nodeType !== Node.ELEMENT_NODE ? node.parentElement : node;
    while (current && current !== deps.canvas && deps.canvas.contains(current)) {
      if (isTarget(current)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function labelOf(element) {
    const name = element.tagName === 'P' ? '段落' : element.tagName;
    const text = element.textContent.replace(/\s+/g, ' ').trim();
    const short = text.length > LABEL_LENGTH ? text.slice(0, LABEL_LENGTH) + '…' : text;
    return name + ': ' + (short || (element.querySelector('img') ? '(画像)' : '(空)'));
  }

  /* ---------- 種類の変更 ---------- */
  function setTargetType(element, tag) {
    if (!element || !isTarget(element) || element.tagName.toLowerCase() === tag) return element;
    const next = document.createElement(tag);
    window.CmsBlocks.runOp(function () {
      Array.from(element.attributes).forEach(function (attr) { next.setAttribute(attr.name, attr.value); });
      next.removeAttribute('data-cms-auto');
      while (element.firstChild) next.appendChild(element.firstChild);
      element.replaceWith(next);
      // 見出しに画像などが残らないよう外へ出す
      if (content().isHeading(next) && content().liftFromHeading(next) &&
          content().isVisuallyBlank(next) && !next.querySelector('br')) {
        next.appendChild(document.createElement('br'));
      }
    });
    deps.afterChange();
    return next;
  }

  /* ---------- ID ---------- */
  function linksTo(id) {
    return Array.from(deps.canvas.querySelectorAll('a[href^="#"]')).filter(function (link) {
      const hash = link.getAttribute('href').slice(1);
      if (hash === id) return true;
      try {
        return decodeURIComponent(hash) === id;
      } catch {
        return false;
      }
    });
  }

  // 反映できた場合は true。拒否・取り消しの場合は false
  function setElementId(element, value) {
    if (!element || !deps.canvas.contains(element)) return false;
    const id = value.trim();
    const old = element.getAttribute('id') || '';
    if (id === old) return true;
    if (INVALID_ID.test(id)) {
      deps.toast('IDに空白や記号（" \' < > { } # &）は使えません', '⚠️');
      return false;
    }
    const duplicated = id && Array.from(deps.canvas.querySelectorAll('[id]')).some(function (el) {
      return el !== element && el.id === id;
    });
    if (duplicated) {
      deps.toast('ID「' + id + '」は本文内で使用中です', '⚠️');
      return false;
    }
    const links = old ? linksTo(old) : [];
    let relink = false;
    if (links.length && id) {
      relink = confirm('「#' + old + '」へのページ内リンクが ' + links.length + ' 件あります。新しいIDに更新しますか？');
    } else if (links.length &&
        !confirm('「#' + old + '」へのページ内リンクが ' + links.length + ' 件あり、リンク切れになります。IDを削除しますか？')) {
      return false;
    }
    window.CmsBlocks.runOp(function () {
      if (id) element.setAttribute('id', id);
      else element.removeAttribute('id');
      if (relink) links.forEach(function (link) { link.setAttribute('href', '#' + id); });
    });
    deps.afterChange();
    return true;
  }

  /* ---------- ブロックの追加 ---------- */
  function createEmptyBlock(kind) {
    if (kind === 'ul' || kind === 'ol' || kind === 'quote') {
      const outer = document.createElement(kind === 'quote' ? 'blockquote' : kind);
      const inner = content().createParagraph(document);
      if (kind === 'quote') {
        outer.appendChild(inner);
      } else {
        const item = document.createElement('li');
        item.appendChild(document.createElement('br'));
        outer.appendChild(item);
      }
      outer.setAttribute('data-cms-auto', '');
      return outer;
    }
    const element = content().createAutoParagraph(document);
    if (!/^h[2-4]$/.test(kind)) return element;
    const heading = document.createElement(kind);
    heading.setAttribute('data-cms-auto', '');
    heading.appendChild(document.createElement('br'));
    return heading;
  }

  // elements（選択中のブロックや章）の前後に追加する。何も入力されなければ保存されない
  function insertBlock(kind, position, elements) {
    const list = (elements || blocks).filter(function (el) { return el.parentNode === deps.canvas; });
    if (!list.length) return;
    const element = createEmptyBlock(kind);
    window.CmsBlocks.runOp(function () {
      if (position === 'before') list[0].before(element);
      else list[list.length - 1].after(element);
    });
    deps.canvas.focus({ preventScroll: true });
    const host = element.querySelector('li, p') || element;
    window.getSelection().collapse(host, 0);
    element.scrollIntoView({ block: 'nearest' });
    window.CmsBlocks.hide();
    deps.afterChange();
    // 表や画像などは、空行にカーソルを置いてから既存の挿入画面を開く
    if (deps.openers[kind]) deps.openers[kind]();
  }

  /* ---------- 画面 ---------- */
  function createControl(tag, label) {
    const control = document.createElement(tag);
    control.className = 'cms-block-field';
    control.setAttribute('aria-label', label);
    control.title = label;
    return control;
  }

  function createOption(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  function drawOutline() {
    if (!target || !target.isConnected || !target.offsetHeight) {
      outline.style.display = 'none';
      return;
    }
    const base = deps.container.getBoundingClientRect();
    const canvas = deps.canvas.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const top = Math.max(rect.top - 2, canvas.top);
    const bottom = Math.min(rect.bottom + 2, canvas.bottom);
    outline.style.display = bottom > top ? 'block' : 'none';
    outline.style.top = top - base.top + deps.container.scrollTop + 'px';
    outline.style.left = rect.left - base.left + deps.container.scrollLeft - 2 + 'px';
    outline.style.width = rect.width + 4 + 'px';
    outline.style.height = Math.max(0, bottom - top) + 'px';
  }

  function showTarget() {
    const fields = [targetSelect, typeSelect, idInput];
    fields.forEach(function (field) { field.hidden = !target; });
    if (target) {
      const tag = target.tagName.toLowerCase();
      const options = TYPES.map(function (type) { return createOption(type[0], type[1]); });
      if (tag === 'h1') options.unshift(createOption('h1', '見出し1'));
      typeSelect.replaceChildren.apply(typeSelect, options);
      typeSelect.value = tag;
      targetSelect.value = String(targets.indexOf(target));
      idInput.value = target.getAttribute('id') || '';
    }
  }

  // 操作パネルの表示に合わせて対象一覧を作り直す
  function refresh(elements, preferred) {
    // 入力中にスクロールなどで呼ばれても、打ちかけの内容と対象は保つ
    if (!row || isUsingField()) return;
    blocks = elements;
    targets = listTargets(elements);
    const selection = window.getSelection();
    const candidates = [preferred, target, selection.rangeCount ? targetAt(selection.anchorNode) : null];
    target = candidates.find(function (el) { return el && targets.includes(el); }) || targets[0] || null;
    targetSelect.replaceChildren.apply(targetSelect, targets.map(function (el, index) {
      return createOption(String(index), labelOf(el));
    }));
    showTarget();
  }

  function closeMenu() {
    if (menu) menu.hidden = true;
  }

  function clear() {
    if (!row) return;
    closeMenu();
    outline.style.display = 'none';
    target = null;
    targets = [];
    blocks = [];
  }

  // 入力欄や追加メニューを使っている間は、対象ブロックを切り替えない
  function isUsingField() {
    const active = document.activeElement;
    return Boolean(row && active && row.contains(active) && active.matches('select, input'));
  }

  function isBusy() {
    return Boolean(row) && (!menu.hidden || isUsingField());
  }

  function openMenu(position) {
    const reopen = menu.hidden || addPosition !== position;
    addPosition = position;
    menu.hidden = !reopen;
    menu.setAttribute('aria-label', position === 'before' ? '上に追加' : '下に追加');
  }

  function applyType() {
    const next = setTargetType(target, typeSelect.value);
    typeSelect.blur();
    if (!next) return;
    target = next;
    let block = next;
    while (block.parentElement && block.parentElement !== deps.canvas) block = block.parentElement;
    window.CmsBlocks.show(block, next);
  }

  function applyId() {
    if (!target) return;
    if (!setElementId(target, idInput.value)) idInput.value = target.getAttribute('id') || '';
    else drawOutline();
  }

  function buildRow(toolbar) {
    row = document.createElement('div');
    row.className = 'cms-block-row';
    targetSelect = createControl('select', '操作する見出し・段落');
    typeSelect = createControl('select', '種類');
    idInput = createControl('input', 'ID（Enterで反映）');
    idInput.type = 'text';
    idInput.placeholder = 'ID';
    const adders = [['before', '＋上', '上にブロックを追加'], ['after', '＋下', '下にブロックを追加']].map(function (item) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cms-block-btn';
      button.setAttribute('data-add', item[0]);
      button.title = item[2];
      button.setAttribute('aria-label', item[2]);
      button.textContent = item[1];
      return button;
    });
    menu = document.createElement('div');
    menu.className = 'cms-block-menu';
    menu.hidden = true;
    KINDS.forEach(function (kind) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cms-block-btn';
      button.setAttribute('data-kind', kind[0]);
      button.textContent = kind[1];
      menu.appendChild(button);
    });
    row.append.apply(row, [targetSelect, typeSelect, idInput].concat(adders, menu));
    toolbar.appendChild(row);

    targetSelect.addEventListener('change', function () {
      target = targets[Number(targetSelect.value)] || null;
      targetSelect.blur();
      showTarget();
      drawOutline();
    });
    typeSelect.addEventListener('change', applyType);
    idInput.addEventListener('change', applyId);
    idInput.addEventListener('keydown', function (e) {
      if (e.isComposing || (e.key !== 'Enter' && e.key !== 'Escape')) return;
      e.preventDefault();
      if (e.key === 'Escape') idInput.value = target ? target.getAttribute('id') || '' : '';
      idInput.blur();
    });
    row.addEventListener('click', function (e) {
      const button = e.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-add')) openMenu(button.getAttribute('data-add'));
      else if (button.hasAttribute('data-kind')) insertBlock(button.getAttribute('data-kind'), addPosition);
    });
    document.addEventListener('mousedown', function (e) {
      if (!row.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });
  }

  function init(options) {
    deps = options;
    outline = document.createElement('div');
    outline.className = 'cms-target-outline';
    deps.container.appendChild(outline);
    buildRow(window.CmsBlocks.getToolbar());
  }

  window.CmsBlockEdit = {
    init,
    refresh,
    drawOutline,
    clear,
    isBusy,
    targetAt,
    listTargets,
    setTargetType,
    setElementId,
    insertBlock,
  };
})();
