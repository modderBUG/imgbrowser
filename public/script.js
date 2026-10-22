/**
 * ImgBrowser 前端逻辑
 * - 服务端分页 + 文件名搜索，滚动到底自动加载
 * - 所有用户数据都以 textContent 渲染，避免文件名注入 HTML
 * - 事件统一委托到容器，视图/标签按钮取 dataset 时使用按钮本身而非事件目标
 */
(() => {
  'use strict';

  const PREFS_KEY = 'imgbrowser:prefs';
  const VIEWS = ['waterfall', 'grid', 'list'];
  const SORTS = ['name', 'newest', 'oldest'];
  const ZOOM_STEPS = [1, 1.5, 2, 3, 4];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const els = {
    gallery: document.getElementById('gallery'),
    summary: document.getElementById('summary'),
    searchInput: document.getElementById('searchInput'),
    searchClear: document.getElementById('searchClear'),
    sortSelect: document.getElementById('sortSelect'),
    viewButtons: Array.from(document.querySelectorAll('[data-view]')),
    tabButtons: Array.from(document.querySelectorAll('[data-show]')),
    trashBadge: document.getElementById('trashBadge'),
    emptyTrashBtn: document.getElementById('emptyTrashBtn'),
    emptyState: document.getElementById('emptyState'),
    emptyTitle: document.getElementById('emptyTitle'),
    emptyHint: document.getElementById('emptyHint'),
    emptyAction: document.getElementById('emptyAction'),
    errorState: document.getElementById('errorState'),
    errorText: document.getElementById('errorText'),
    retryBtn: document.getElementById('retryBtn'),
    sentinel: document.getElementById('sentinel'),
    loading: document.getElementById('loading'),
    endMessage: document.getElementById('endMessage'),
    scanBtn: document.getElementById('scanBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    backToTop: document.getElementById('backToTop'),
    toast: document.getElementById('toast'),
    modal: document.getElementById('modal'),
    modalImage: document.getElementById('modalImage'),
    modalTitle: document.getElementById('modalTitle'),
    modalMeta: document.getElementById('modalMeta'),
    modalClose: document.getElementById('modalClose'),
    modalFavorite: document.getElementById('modalFavorite'),
    modalDelete: document.getElementById('modalDelete'),
    modalZoomIn: document.getElementById('modalZoomIn'),
    modalZoomOut: document.getElementById('modalZoomOut'),
    zoomLevel: document.getElementById('zoomLevel'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    stage: document.querySelector('.modal-stage'),
  };

  const state = {
    view: 'waterfall',
    sort: 'name',
    show: 'all',
    q: '',
    page: 1,
    limit: 24,
    items: [],
    total: 0,
    hasMore: true,
    loading: false,
    epoch: 0,
    controller: null,
    stats: { total: 0, favorites: 0, trashed: 0, all: 0, bytes: 0 },
    modalIndex: -1,
    zoom: 1,
    panX: 0,
    panY: 0,
    drag: null,
    lastFocused: null,
    toastTimer: null,
  };

  /* ---------------------------------------------------------------- */
  /* 工具函数                                                          */
  /* ---------------------------------------------------------------- */

  function svgIcon(name, className = 'icon') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  function parseTimestamp(item) {
    if (Number.isFinite(item.mtime) && item.mtime > 0) return new Date(item.mtime);
    if (item.created_at) {
      // SQLite 的 datetime('now') 是 UTC，补上 Z 再解析
      return new Date(`${item.created_at.replace(' ', 'T')}Z`);
    }
    return null;
  }

  function formatDate(item) {
    const date = parseTimestamp(item);
    if (!date || Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  function metaLine(item) {
    const parts = [];
    if (item.width && item.height) parts.push(`${item.width} × ${item.height}`);
    const size = formatBytes(item.size);
    if (size) parts.push(size);
    const date = formatDate(item);
    if (date) parts.push(date);
    return parts.join(' · ');
  }

  function isTyping(target) {
    return (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  function findItem(id) {
    return state.items.find((item) => item.id === id);
  }

  function redirectToLogin() {
    window.location.href = '/login.html';
  }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

    const response = await fetch(path, { ...options, headers });
    if (response.status === 401) {
      redirectToLogin();
      throw new Error('登录已过期');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  function toast(message, type = 'success') {
    const node = els.toast;
    node.textContent = message;
    node.classList.toggle('is-error', type === 'error');
    node.classList.toggle('is-success', type !== 'error');
    node.hidden = false;
    void node.offsetWidth;
    node.classList.add('is-visible');

    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      node.classList.remove('is-visible');
      setTimeout(() => {
        node.hidden = true;
      }, 220);
    }, 2600);
  }

  /* ---------------------------------------------------------------- */
  /* 偏好设置                                                          */
  /* ---------------------------------------------------------------- */

  function loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      if (VIEWS.includes(prefs.view)) state.view = prefs.view;
      if (SORTS.includes(prefs.sort)) state.sort = prefs.sort;
    } catch {
      /* 忽略损坏的本地存储 */
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ view: state.view, sort: state.sort }));
    } catch {
      /* 隐私模式下可能不可写 */
    }
  }

  /* ---------------------------------------------------------------- */
  /* 渲染                                                              */
  /* ---------------------------------------------------------------- */

  function makeActionButton(iconName, label, action, active = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `icon-btn${active ? ' is-active' : ''}`;
    button.dataset.action = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', String(active));
    button.appendChild(svgIcon(iconName));
    return button;
  }

  function createCard(item) {
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = String(item.id);
    if (item.deleted) card.classList.add('is-deleted');
    if (item.width && item.height) card.style.setProperty('--ar', `${item.width} / ${item.height}`);

    const media = document.createElement('button');
    media.type = 'button';
    media.className = 'card-media';
    media.dataset.action = 'open';
    media.setAttribute('aria-label', `查看大图：${item.filename}`);

    const img = document.createElement('img');
    img.src = item.url;
    img.alt = item.filename;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener(
      'load',
      () => {
        media.classList.add('is-loaded');
        // 服务端没解析出尺寸时，用真实尺寸兜底，避免占位比例错误
        if ((!item.width || !item.height) && img.naturalWidth && img.naturalHeight) {
          item.width = img.naturalWidth;
          item.height = img.naturalHeight;
          card.style.setProperty('--ar', `${item.width} / ${item.height}`);
          const meta = card.querySelector('.card-meta');
          if (meta) meta.textContent = metaLine(item);
        }
      },
      { once: true }
    );
    img.addEventListener('error', () => media.classList.add('is-loaded'), { once: true });
    media.appendChild(img);

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    if (item.deleted) {
      actions.append(
        makeActionButton('undo', '恢复', 'restore'),
        makeActionButton('trash', '永久删除', 'purge')
      );
    } else {
      actions.append(
        makeActionButton('heart', item.favorited ? '取消收藏' : '收藏', 'favorite', item.favorited),
        makeActionButton('trash', '移到回收站', 'delete')
      );
    }

    const info = document.createElement('div');
    info.className = 'card-info';
    const title = document.createElement('h3');
    title.textContent = item.filename;
    title.title = item.filename;
    const meta = document.createElement('p');
    meta.className = 'card-meta';
    meta.textContent = metaLine(item);
    info.append(title, meta);

    card.append(media, actions, info);
    return card;
  }

  function renderCards(items) {
    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.append(createCard(item)));
    els.gallery.append(fragment);
  }

  function removeCardElement(id) {
    const card = els.gallery.querySelector(`.card[data-id="${id}"]`);
    if (card) card.remove();
  }

  function syncFavoriteButton(card, item) {
    if (!card) return;
    const button = card.querySelector('[data-action="favorite"]');
    if (!button) return;
    button.classList.toggle('is-active', item.favorited);
    button.setAttribute('aria-pressed', String(item.favorited));
    const label = item.favorited ? '取消收藏' : '收藏';
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function updateSummary() {
    // 加载失败时数字没有意义，隐藏整行
    els.summary.hidden = !els.errorState.hidden;
    if (els.summary.hidden) return;

    const unfiltered = state.show === 'all' && !state.q;
    const countText = (() => {
      if (state.show === 'favorites') return `收藏 ${state.total} 张`;
      if (state.show === 'trash') return `回收站 ${state.total} 张`;
      // 体积只在整个图片库未筛选时显示，否则数字会对不上
      return unfiltered
        ? `共 ${state.total} 张图片 · ${formatBytes(state.stats.bytes) || '0 B'}`
        : `共 ${state.total} 张图片`;
    })();

    const parts = [countText];
    if (state.q) parts.push(`匹配“${state.q}”`);
    if (state.hasMore && state.items.length) parts.push(`已加载 ${state.items.length}`);
    els.summary.textContent = parts.join(' · ');
  }

  function updateEmptyState() {
    // 出错时由错误面板负责提示，避免两个空状态同时出现
    const isEmpty = !state.loading && els.errorState.hidden && state.total === 0;
    els.emptyState.hidden = !isEmpty;
    if (!isEmpty) return;

    let title = '这里还没有图片';
    let hint = '把图片放进 IMAGES_DIR 指向的目录，然后点击「RESCAN」扫描即可。';
    let actionLabel = '重新扫描';

    if (state.q) {
      title = '没有匹配的图片';
      hint = `没有找到文件名包含“${state.q}”的图片，换个关键词试试。`;
      actionLabel = '清除搜索';
    } else if (state.show === 'favorites') {
      title = '还没有收藏';
      hint = '在图片上点击心形按钮，收藏会显示在这里。';
      actionLabel = '';
    } else if (state.show === 'trash') {
      title = '回收站是空的';
      hint = '被删除的图片会先放进回收站，可以随时恢复。';
      actionLabel = '';
    } else if (state.stats.all > 0) {
      title = '这里还没有图片';
      hint = `图片库中已经有 ${state.stats.all} 个文件，但当前筛选条件下没有结果。`;
    }

    els.emptyTitle.textContent = title;
    els.emptyHint.textContent = hint;
    els.emptyAction.hidden = !actionLabel;
    els.emptyAction.textContent = actionLabel;
    els.emptyAction.dataset.mode = state.q ? 'clear-search' : 'rescan';
  }

  function updateChrome() {
    updateSummary();
    updateEmptyState();

    els.trashBadge.hidden = state.stats.trashed === 0;
    els.trashBadge.textContent = String(state.stats.trashed);

    els.emptyTrashBtn.hidden = state.show !== 'trash' || state.stats.trashed === 0;
    els.endMessage.hidden = state.hasMore || state.total === 0 || state.loading;
    els.searchClear.hidden = els.searchInput.value.trim() === '';
  }

  function setBusy(busy) {
    els.gallery.setAttribute('aria-busy', String(busy));
    els.loading.hidden = !busy;
  }

  function showError(message) {
    els.errorText.textContent = message;
    els.errorState.hidden = false;
    els.emptyState.hidden = true;
    els.endMessage.hidden = true;
  }

  function hideError() {
    els.errorState.hidden = true;
  }

  /* ---------------------------------------------------------------- */
  /* 数据加载                                                          */
  /* ---------------------------------------------------------------- */

  function resetList() {
    state.epoch += 1;
    state.controller?.abort();
    state.controller = null;
    state.page = 1;
    state.items = [];
    state.total = 0;
    state.hasMore = true;
    state.loading = false;
    els.gallery.replaceChildren();
    hideError();
  }

  async function loadPage() {
    if (state.loading || !state.hasMore) return;
    // 出错后不再自动加载，等用户点「重试」（重试会先 hideError 再重新加载）
    if (!els.errorState.hidden) return;

    const epoch = state.epoch;
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    setBusy(true);

    const params = new URLSearchParams({
      page: String(state.page),
      limit: String(state.limit),
      sort: state.sort,
      show: state.show,
    });
    if (state.q) params.set('q', state.q);

    try {
      const response = await fetch(`/api/images?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });

      if (epoch !== state.epoch) return;
      if (response.status === 401) {
        redirectToLogin();
        return;
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `加载失败（${response.status}）`);
      if (epoch !== state.epoch) return;

      state.total = data.pagination.total;
      state.hasMore = data.pagination.hasNext;
      state.items.push(...data.images);
      renderCards(data.images);
      state.page = data.pagination.page + 1;
      updateChrome();
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (epoch === state.epoch) showError(error.message);
    } finally {
      if (epoch === state.epoch) {
        state.loading = false;
        state.controller = null;
        setBusy(false);
        updateChrome();
        maybeLoadMore();
      }
    }
  }

  /** 首屏/短列表时哨兵可能一直在视口内，需要主动补一次加载。 */
  function maybeLoadMore() {
    if (!state.hasMore || state.loading) return;
    // 出错时停下等待用户点重试，否则哨兵仍在视口内会立刻再请求一次，形成失败循环
    if (!els.errorState.hidden) return;
    const rect = els.sentinel.getBoundingClientRect();
    if (rect.top < window.innerHeight + 600) loadPage();
  }

  async function refreshStats() {
    try {
      state.stats = await api('/api/stats');
      updateChrome();
    } catch (error) {
      console.warn('获取统计信息失败：', error.message);
    }
  }

  async function reload({ silently = false } = {}) {
    resetList();
    if (!silently) updateChrome();
    await loadPage();
  }

  /* ---------------------------------------------------------------- */
  /* 图片操作                                                          */
  /* ---------------------------------------------------------------- */

  function removeItem(id, { closeModal = true } = {}) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index >= 0) state.items.splice(index, 1);
    state.total = Math.max(0, state.total - 1);
    removeCardElement(id);

    if (state.modalIndex >= 0) {
      if (state.items.length === 0) {
        closeModal();
      } else {
        // 删掉的是当前这张：索引留在原位即自动指向下一张
        // 删掉的是前面的：索引需要前移，否则会跳一张
        if (index < state.modalIndex) state.modalIndex -= 1;
        state.modalIndex = Math.min(state.modalIndex, state.items.length - 1);
        if (closeModal) renderModal();
      }
    }

    updateChrome();
  }

  async function toggleFavorite(id) {
    const item = findItem(id);
    if (!item) return;

    item.favorited = !item.favorited;
    syncFavoriteButton(els.gallery.querySelector(`.card[data-id="${id}"]`), item);
    syncModalFavorite();

    try {
      const data = await api(`/api/images/${id}/favorite`, { method: 'POST' });
      item.favorited = Boolean(data.favorited);
      syncFavoriteButton(els.gallery.querySelector(`.card[data-id="${id}"]`), item);
      syncModalFavorite();
      await refreshStats();

      if (state.show === 'favorites' && !item.favorited) {
        removeItem(id);
        toast('已取消收藏');
      }
    } catch (error) {
      item.favorited = !item.favorited;
      syncFavoriteButton(els.gallery.querySelector(`.card[data-id="${id}"]`), item);
      syncModalFavorite();
      toast(error.message, 'error');
    }
  }

  async function moveToTrash(id) {
    if (!window.confirm('移到回收站？可以随时在「回收站」里恢复。')) return;
    try {
      await api(`/api/images/${id}/delete`, { method: 'POST' });
      removeItem(id);
      await refreshStats();
      toast('已移到回收站');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function restoreFromTrash(id) {
    try {
      const data = await api(`/api/images/${id}/restore`, { method: 'POST' });
      removeItem(id);
      await refreshStats();
      toast(data.filename && data.filename !== '' ? `已恢复：${data.filename}` : '已恢复');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function purgeImage(id) {
    if (!window.confirm('永久删除？文件会从磁盘移除，无法恢复。')) return;
    try {
      await api(`/api/images/${id}`, { method: 'DELETE' });
      removeItem(id);
      await refreshStats();
      toast('已永久删除');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function emptyTrash() {
    if (!window.confirm('清空回收站？其中的文件会被永久删除。')) return;
    try {
      const data = await api('/api/trash/empty', { method: 'POST' });
      await Promise.all([refreshStats(), reload()]);
      toast(`已清空回收站（${data.deletedCount} 张）`);
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function rescan() {
    els.scanBtn.disabled = true;
    toast('正在扫描图片目录…');
    try {
      const data = await api('/api/scan', { method: 'POST' });
      await Promise.all([refreshStats(), reload()]);
      toast(`扫描完成：新增 ${data.added}，更新 ${data.updated}，清理 ${data.removed}`);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      els.scanBtn.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* 大图查看                                                          */
  /* ---------------------------------------------------------------- */

  function isModalOpen() {
    return !els.modal.hidden;
  }

  function openModal(id) {
    const index = state.items.findIndex((item) => item.id === id);
    if (index < 0) return;

    state.modalIndex = index;
    state.lastFocused = document.activeElement;
    els.modal.hidden = false;
    document.body.classList.add('no-scroll');
    renderModal();
    requestAnimationFrame(() => els.modal.classList.add('is-open'));
    els.modalClose.focus({ preventScroll: true });
  }

  function closeModal() {
    if (!isModalOpen()) return;
    state.modalIndex = -1;
    els.modal.classList.remove('is-open');
    els.modal.hidden = true;
    document.body.classList.remove('no-scroll');
    resetZoom();
    els.modalImage.removeAttribute('src');
    if (state.lastFocused instanceof HTMLElement) state.lastFocused.focus({ preventScroll: true });
  }

  function renderModal() {
    const item = state.items[state.modalIndex];
    if (!item) {
      closeModal();
      return;
    }

    els.modalImage.src = item.url;
    els.modalImage.alt = item.filename;
    els.modalTitle.textContent = item.filename;
    els.modalMeta.textContent = [metaLine(item), item.deleted ? '在回收站' : '']
      .filter(Boolean)
      .join(' · ');

    els.prevBtn.disabled = state.modalIndex === 0;
    els.nextBtn.disabled = state.modalIndex >= state.items.length - 1 && !state.hasMore;

    els.modalDelete.title = item.deleted ? '永久删除' : '移到回收站';
    els.modalDelete.setAttribute('aria-label', els.modalDelete.title);
    syncModalFavorite();
    resetZoom();
  }

  function syncModalFavorite() {
    const item = state.items[state.modalIndex];
    if (!item) return;
    els.modalFavorite.classList.toggle('is-active', item.favorited);
    els.modalFavorite.setAttribute('aria-pressed', String(item.favorited));
    els.modalFavorite.disabled = item.deleted;
    els.modalFavorite.title = item.deleted ? '回收站中的图片不能收藏' : item.favorited ? '取消收藏' : '收藏';
  }

  async function step(delta) {
    if (!isModalOpen()) return;
    const nextIndex = state.modalIndex + delta;
    if (nextIndex < 0) return;

    if (nextIndex >= state.items.length) {
      if (!state.hasMore) return;
      const before = state.items.length;
      await loadPage();
      if (state.items.length <= before) return;
    }

    state.modalIndex = nextIndex;
    renderModal();
    if (state.hasMore && state.modalIndex > state.items.length - 3) loadPage();
  }

  function clampPan() {
    const maxX = Math.max(0, (els.modalImage.clientWidth * state.zoom - els.stage.clientWidth) / 2);
    const maxY = Math.max(0, (els.modalImage.clientHeight * state.zoom - els.stage.clientHeight) / 2);
    state.panX = Math.min(maxX, Math.max(-maxX, state.panX));
    state.panY = Math.min(maxY, Math.max(-maxY, state.panY));
  }

  function applyTransform() {
    els.modalImage.style.transform = `translate3d(${state.panX}px, ${state.panY}px, 0) scale(${state.zoom})`;
    els.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
    els.modalImage.classList.toggle('is-zoomed', state.zoom > 1);
    els.modalZoomIn.disabled = state.zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
    els.modalZoomOut.disabled = state.zoom <= 1;
  }

  function setZoom(zoom) {
    state.zoom = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(1, zoom));
    if (state.zoom === 1) {
      state.panX = 0;
      state.panY = 0;
    } else {
      clampPan();
    }
    applyTransform();
  }

  function zoomBy(direction) {
    const current = ZOOM_STEPS.findIndex((stepValue) => stepValue >= state.zoom - 0.001);
    const nextIndex = Math.min(
      ZOOM_STEPS.length - 1,
      Math.max(0, (current < 0 ? 0 : current) + direction)
    );
    setZoom(ZOOM_STEPS[nextIndex]);
  }

  function resetZoom() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    els.modalImage.style.transform = '';
    els.zoomLevel.textContent = '100%';
    els.modalImage.classList.remove('is-zoomed', 'is-dragging');
    els.modalZoomIn.disabled = false;
    els.modalZoomOut.disabled = true;
  }

  function onPointerDown(event) {
    if (state.zoom <= 1 || event.button !== 0) return;
    state.drag = { x: event.clientX - state.panX, y: event.clientY - state.panY, id: event.pointerId };
    els.modalImage.classList.add('is-dragging');
    els.modalImage.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!state.drag || state.drag.id !== event.pointerId) return;
    state.panX = event.clientX - state.drag.x;
    state.panY = event.clientY - state.drag.y;
    clampPan();
    applyTransform();
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (!state.drag) return;
    state.drag = null;
    els.modalImage.classList.remove('is-dragging');
    els.modalImage.releasePointerCapture?.(event.pointerId);
  }

  /* ---------------------------------------------------------------- */
  /* 事件绑定                                                          */
  /* ---------------------------------------------------------------- */

  function setView(view) {
    if (!VIEWS.includes(view) || view === state.view) return;
    state.view = view;
    els.gallery.className = `gallery view-${view}`;
    els.viewButtons.forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    savePrefs();
  }

  function setTab(show) {
    if (state.show === show) return;
    state.show = show;
    els.tabButtons.forEach((button) => {
      const active = button.dataset.show === show;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    reload();
  }

  function bindEvents() {
    els.viewButtons.forEach((button) => {
      // 用 button 本身取 dataset：点在图标上时 event.target 是 <svg>/<use>
      button.addEventListener('click', () => setView(button.dataset.view));
    });

    els.tabButtons.forEach((button) => {
      button.addEventListener('click', () => setTab(button.dataset.show));
    });

    els.sortSelect.addEventListener('change', () => {
      if (!SORTS.includes(els.sortSelect.value)) return;
      state.sort = els.sortSelect.value;
      savePrefs();
      reload();
    });

    let searchTimer = null;
    els.searchInput.addEventListener('input', () => {
      els.searchClear.hidden = els.searchInput.value.trim() === '';
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const value = els.searchInput.value.trim();
        if (value === state.q) return;
        state.q = value;
        reload();
      }, 250);
    });

    els.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        els.searchInput.value = '';
        els.searchClear.hidden = true;
        if (state.q) {
          state.q = '';
          reload();
        }
      }
    });

    els.searchClear.addEventListener('click', () => {
      els.searchInput.value = '';
      els.searchClear.hidden = true;
      if (state.q) {
        state.q = '';
        reload();
      }
      els.searchInput.focus();
    });

    els.gallery.addEventListener('click', (event) => {
      const actionButton = event.target.closest('[data-action]');
      if (actionButton) {
        const card = actionButton.closest('.card');
        const id = Number(card?.dataset.id);
        if (!Number.isFinite(id)) return;
        const action = actionButton.dataset.action;
        if (action === 'open') openModal(id);
        else if (action === 'favorite') toggleFavorite(id);
        else if (action === 'delete') moveToTrash(id);
        else if (action === 'restore') restoreFromTrash(id);
        else if (action === 'purge') purgeImage(id);
        return;
      }

      const card = event.target.closest('.card');
      if (card) openModal(Number(card.dataset.id));
    });

    els.emptyAction.addEventListener('click', () => {
      if (els.emptyAction.dataset.mode === 'clear-search') {
        els.searchInput.value = '';
        els.searchClear.hidden = true;
        state.q = '';
        reload();
        return;
      }
      rescan();
    });

    els.emptyTrashBtn.addEventListener('click', emptyTrash);
    els.retryBtn.addEventListener('click', () => {
      hideError();
      reload();
    });
    els.scanBtn.addEventListener('click', rescan);
    els.logoutBtn.addEventListener('click', async () => {
      if (!window.confirm('确定退出登录？')) return;
      try {
        await api('/api/logout', { method: 'POST' });
      } catch {
        /* 即使请求失败也跳转登录页 */
      }
      redirectToLogin();
    });

    els.backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // 滚动相关统一用 rAF 节流，避免多个防抖监听互相抢时序
    let ticking = false;
    window.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(() => {
          els.backToTop.hidden = window.scrollY < 400;
          ticking = false;
        });
      },
      { passive: true }
    );

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadPage();
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(els.sentinel);

    // 模态框
    els.modalClose.addEventListener('click', closeModal);
    els.modal.addEventListener('click', (event) => {
      if (event.target.closest('[data-close]')) closeModal();
    });
    els.prevBtn.addEventListener('click', () => step(-1));
    els.nextBtn.addEventListener('click', () => step(1));
    els.modalFavorite.addEventListener('click', () => {
      const item = state.items[state.modalIndex];
      if (item) toggleFavorite(item.id);
    });
    els.modalDelete.addEventListener('click', () => {
      const item = state.items[state.modalIndex];
      if (!item) return;
      if (item.deleted) purgeImage(item.id);
      else moveToTrash(item.id);
    });
    els.modalZoomIn.addEventListener('click', () => zoomBy(1));
    els.modalZoomOut.addEventListener('click', () => zoomBy(-1));
    els.modalImage.addEventListener('dblclick', () => setZoom(state.zoom > 1 ? 1 : 2));
    els.modalImage.addEventListener('pointerdown', onPointerDown);
    els.modalImage.addEventListener('pointermove', onPointerMove);
    els.modalImage.addEventListener('pointerup', onPointerUp);
    els.modalImage.addEventListener('pointercancel', onPointerUp);

    document.addEventListener('keydown', (event) => {
      if (isTyping(event.target)) return;

      if (!isModalOpen()) {
        // 列表页快捷键：/ 聚焦搜索
        if (event.key === '/' && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          els.searchInput.focus();
        }
        return;
      }

      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          closeModal();
          break;
        case 'ArrowLeft':
          event.preventDefault();
          step(-1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          step(1);
          break;
        case '+':
        case '=':
          event.preventDefault();
          zoomBy(1);
          break;
        case '-':
        case '_':
          event.preventDefault();
          zoomBy(-1);
          break;
        case '0':
          event.preventDefault();
          setZoom(1);
          break;
        case 'f':
        case 'F':
          event.preventDefault();
          {
            const item = state.items[state.modalIndex];
            if (item && !item.deleted) toggleFavorite(item.id);
          }
          break;
        case 'd':
        case 'D':
          event.preventDefault();
          {
            const item = state.items[state.modalIndex];
            if (!item) break;
            if (item.deleted) purgeImage(item.id);
            else moveToTrash(item.id);
          }
          break;
        default:
          break;
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* 初始化                                                            */
  /* ---------------------------------------------------------------- */

  function init() {
    loadPrefs();

    els.sortSelect.value = state.sort;
    els.viewButtons.forEach((button) => {
      const active = button.dataset.view === state.view;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    els.gallery.className = `gallery view-${state.view}`;

    bindEvents();
    refreshStats();
    reload();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
