(() => {
  'use strict';

  const PAGE_NAMES = ['plan', 'supervise', 'about'];
  const PAGE_TITLES = { plan: '计划', supervise: '监督', about: '关于' };
  const FOCUS_RADIUS = 86;
  const FOCUS_CIRCUMFERENCE = 2 * Math.PI * FOCUS_RADIUS;
  const VALID_HASH = new Set(PAGE_NAMES);

  const PRESET_SECONDS = [25 * 60, 15 * 60, 5 * 60];
  const FOCUS_STORAGE = 'yoa.focus.v1';
  const PENDING_STOP = 'yoa.focus.pending-stop.v1';
  const NOTIFIED_STORAGE = 'yoa.focus.notified.v1';
  const MAX_NOTIFIED = 40;

  const state = {
    authenticated: false,
    dashboard: null,
    activePage: 'plan',
    focus: {
      duration: 25 * 60,
      remaining: 25 * 60,
      planned: 25 * 60,
      endAt: 0,
      running: false,
      sessionId: null,
      intervalId: null,
      finishing: false,
    },
    toastTimer: null,
  };

  const sheetState = {
    open: false,
    render: null,
    lastFocus: null,
    busy: false,
  };

  const addPlanState = {
    rule: 'once',
    weekdays: new Set(),
  };

  const el = {};

  /* ---------------------------------------------------------------- */
  /* 小工具                                                            */
  /* ---------------------------------------------------------------- */

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function iconUse(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#${id}`);
    svg.appendChild(use);
    return svg;
  }

  function readStore(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      if (value === null || value === undefined) {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, JSON.stringify(value));
      }
    } catch {
      // 隐私模式下 localStorage 可能不可用，忽略即可。
    }
  }

  function localTodayKey() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function weekdayOfDateKey(dateKey) {
    const [year, month, day] = String(dateKey).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

  function weekdaysLabel(days) {
    const unique = [...new Set(days)];
    const sorted = WEEKDAY_ORDER.filter((day) => unique.includes(day));

    if (sorted.length === 7) return '每天';
    if (sorted.length === 5 && [1, 2, 3, 4, 5].every((day) => sorted.includes(day))) {
      return '工作日';
    }
    if (sorted.length === 2 && sorted.includes(0) && sorted.includes(6)) return '周末';

    return `每周${sorted.map((day) => WEEKDAY_LABELS[day]).join('、')}`;
  }

  function todayKey() {
    return (state.dashboard && state.dashboard.today) || localTodayKey();
  }

  function cacheElements() {
    const ids = [
      'boot-screen',
      'login-view',
      'login-form',
      'access-key',
      'toggle-key',
      'login-error',
      'login-button',
      'app-view',
      'top-date',
      'page-plan',
      'page-supervise',
      'page-about',
      'plan-form',
      'plan-input',
      'add-plan-button',
      'plan-list',
      'plan-empty',
      'plan-percent',
      'plan-progress-text',
      'plan-progress-copy',
      'plan-progress-track',
      'plan-progress-bar',
      'plan-count',
      'recurring-manage',
      'recurring-count',
      'focus-state',
      'focus-time',
      'focus-fill',
      'focus-start',
      'focus-reset',
      'stat-focus',
      'stat-streak',
      'stat-completed',
      'checkin-button',
      'checkin-stamp',
      'checkin-hint',
      'change-key-button',
      'logout-button',
      'toast',
      'sheet-layer',
      'sheet-panel',
      'sheet-title',
      'sheet-body',
      'sheet-actions',
    ];

    for (const id of ids) {
      el[id] = document.getElementById(id);
    }

    el.pageTitleNodes = {
      plan: document.getElementById('page-plan'),
      supervise: document.getElementById('page-supervise'),
      about: document.getElementById('page-about'),
    };
    el.tabs = Array.from(document.querySelectorAll('.tab[data-page]'));
    el.pages = Array.from(document.querySelectorAll('.page[data-page]'));
    el.presetButtons = Array.from(document.querySelectorAll('.focus-presets button'));
    el.tabbar = document.querySelector('.tabbar');
    el.eyeOpen = el['toggle-key'].querySelector('.eye-open');
    el.eyeOff = el['toggle-key'].querySelector('.eye-off');
    el.loginButtonLabel = el['login-button'].querySelector('.button-label');
    el.checkinStampText = el['checkin-stamp']
      ? el['checkin-stamp'].querySelector('span')
      : null;
  }

  function api(path, { method = 'GET', body, silent401 = false } = {}) {
    const options = {
      method,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    };

    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    return fetch(path, options)
      .catch(() => {
        throw new Error('无法连接服务器，请稍后再试');
      })
      .then(async (response) => {
        let data = null;

        try {
          data = await response.json();
        } catch {
          data = null;
        }

        if (!response.ok) {
          if (response.status === 401 && state.authenticated && !silent401) {
            expireSession();
          }

          const error = new Error((data && data.error) || '请求失败，请稍后再试');
          error.status = response.status;
          throw error;
        }

        return data;
      });
  }

  function todayLabel(dateKey) {
    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return '今天';

    const [year, month, day] = dateKey.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    return `${month}月${day}日 · 周${weekdays[date.getDay()]}`;
  }

  function timeLabel(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return '';

    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
  }

  function setLoginError(message) {
    if (!el['login-error']) return;
    el['login-error'].textContent = message || '';
    el['login-error'].hidden = !message;
    el['access-key'].setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function shakeLoginForm() {
    el['login-form'].classList.remove('is-shaking');
    void el['login-form'].offsetWidth;
    el['login-form'].classList.add('is-shaking');
    window.setTimeout(() => el['login-form'].classList.remove('is-shaking'), 420);
  }

  function setLoginLoading(loading) {
    el['login-button'].disabled = loading;
    el['login-button'].classList.toggle('is-loading', loading);
    el['login-button'].setAttribute('aria-busy', String(loading));
    el.loginButtonLabel.textContent = loading ? '正在验证…' : '进入 yOA';
  }

  function toast(message, tone = 'default') {
    if (!el.toast) return;
    window.clearTimeout(state.toastTimer);
    el.toast.textContent = message;
    el.toast.classList.toggle('is-error', tone === 'error');
    el.toast.classList.add('is-visible');
    state.toastTimer = window.setTimeout(() => {
      el.toast.classList.remove('is-visible');
    }, 2800);
  }

  /* ---------------------------------------------------------------- */
  /* 底部弹层                                                          */
  /* ---------------------------------------------------------------- */

  function buildSheetActions(actions) {
    const frag = document.createDocumentFragment();

    for (const action of actions) {
      const button = make(
        'button',
        `sheet-action${action.primary ? ' is-primary' : ''}${action.tone ? ` is-${action.tone}` : ''}`,
        action.label
      );
      button.type = 'button';
      if (action.disabled) button.disabled = true;
      button.addEventListener('click', () => {
        if (sheetState.busy) return;
        action.onClick?.();
      });
      frag.appendChild(button);
    }

    return frag;
  }

  function setSheetBusy(busy) {
    sheetState.busy = busy;
    for (const button of el['sheet-panel'].querySelectorAll('button, input, select')) {
      if (button.closest('.sheet-close')) continue;
      button.disabled = busy;
    }
  }

  function renderSheet() {
    if (!sheetState.open || typeof sheetState.render !== 'function') return;

    const { body, actions } = sheetState.render();
    el['sheet-body'].replaceChildren(body || document.createDocumentFragment());

    if (Array.isArray(actions) && actions.length > 0) {
      el['sheet-actions'].hidden = false;
      el['sheet-actions'].replaceChildren(buildSheetActions(actions));
    } else {
      el['sheet-actions'].hidden = true;
      el['sheet-actions'].replaceChildren();
    }

    if (sheetState.busy) setSheetBusy(true);
  }

  function openSheet({ title, render }) {
    if (!sheetState.open) sheetState.lastFocus = document.activeElement;

    sheetState.open = true;
    sheetState.render = render;
    sheetState.busy = false;

    el['sheet-title'].textContent = title;
    el['sheet-layer'].hidden = false;
    document.body.classList.add('is-sheet-open');
    renderSheet();

    const target = el['sheet-body'].querySelector('button, input, select, textarea');
    if (target) target.focus({ preventScroll: true });
  }

  function closeSheet() {
    if (!sheetState.open) return;

    sheetState.open = false;
    sheetState.render = null;
    sheetState.busy = false;
    el['sheet-layer'].hidden = true;
    el['sheet-body'].replaceChildren();
    el['sheet-actions'].replaceChildren();
    el['sheet-actions'].hidden = false;
    document.body.classList.remove('is-sheet-open');

    const target = sheetState.lastFocus;
    sheetState.lastFocus = null;
    if (target && typeof target.focus === 'function') {
      target.focus({ preventScroll: true });
    }
  }

  function trapSheetFocus(event) {
    if (!sheetState.open || event.key !== 'Tab') return;

    const focusable = Array.from(
      el['sheet-panel'].querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    );

    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ---------------------------------------------------------------- */
  /* 添加计划（二级菜单）                                               */
  /* ---------------------------------------------------------------- */

  function buildChoiceChip(label, rule) {
    const button = make('button', 'choice-chip', label);
    button.type = 'button';
    button.dataset.rule = rule;
    const selected = addPlanState.rule === rule;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
    button.addEventListener('click', () => {
      addPlanState.rule = rule;
      if (rule === 'weekly' && addPlanState.weekdays.size === 0) {
        addPlanState.weekdays.add(weekdayOfDateKey(todayKey()));
      }
      renderSheet();
      const focusTarget = el['sheet-body'].querySelector(`[data-rule="${rule}"]`);
      if (focusTarget) focusTarget.focus({ preventScroll: true });
    });
    return button;
  }

  function buildWeekdayChips() {
    const row = make('div', 'weekday-row');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', '每周重复的星期');

    for (const day of WEEKDAY_ORDER) {
      const button = make('button', 'weekday-chip', WEEKDAY_LABELS[day]);
      button.type = 'button';
      const selected = addPlanState.weekdays.has(day);
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.setAttribute('aria-label', `星期${WEEKDAY_LABELS[day]}`);
      button.addEventListener('click', () => {
        if (addPlanState.weekdays.has(day)) addPlanState.weekdays.delete(day);
        else addPlanState.weekdays.add(day);
        renderSheet();
        const focusTarget = el['sheet-body'].querySelector(`[data-weekday="${day}"]`);
        if (focusTarget) focusTarget.focus({ preventScroll: true });
      });
      button.dataset.weekday = String(day);
      row.appendChild(button);
    }

    return row;
  }

  function buildAddPlanBody() {
    const frag = document.createDocumentFragment();
    const title = el['plan-input'].value.trim();

    const summary = make('div', 'sheet-summary');
    summary.appendChild(make('p', 'sheet-summary-title', title));
    summary.appendChild(make('p', 'sheet-summary-meta', '选择它出现的频率'));
    frag.appendChild(summary);

    const choiceTitle = make('p', 'sheet-note', '重复方式');
    const row = make('div', 'choice-row');
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', '重复方式');
    row.append(
      buildChoiceChip('仅今天', 'once'),
      buildChoiceChip('每天', 'daily'),
      buildChoiceChip('每周', 'weekly')
    );
    frag.append(choiceTitle, row);

    if (addPlanState.rule === 'weekly') {
      const picker = make('div', 'weekday-picker');
      picker.appendChild(make('p', 'sheet-note', '每周重复的星期'));
      picker.appendChild(buildWeekdayChips());
      const hint =
        addPlanState.weekdays.size > 0
          ? weekdaysLabel([...addPlanState.weekdays])
          : '请至少选择一天';
      picker.appendChild(
        make('p', 'sheet-hint', `${hint} · 从今天开始生效`)
      );
      frag.appendChild(picker);
    } else if (addPlanState.rule === 'daily') {
      frag.appendChild(
        make('p', 'sheet-hint', '每天都会自动出现在“今日计划”里，从今天开始生效。')
      );
    } else {
      frag.appendChild(make('p', 'sheet-hint', '只添加到今天，不重复。'));
    }

    return frag;
  }

  function addPlanActions() {
    const weeklyEmpty =
      addPlanState.rule === 'weekly' && addPlanState.weekdays.size === 0;

    return [
      { label: '取消', onClick: closeSheet },
      {
        label: '添加',
        primary: true,
        disabled: weeklyEmpty,
        onClick: submitAddPlan,
      },
    ];
  }

  function openAddPlanSheet() {
    const title = el['plan-input'].value.trim();
    if (!title) {
      el['plan-input'].focus();
      return;
    }

    addPlanState.rule = 'once';
    addPlanState.weekdays = new Set([weekdayOfDateKey(todayKey())]);

    openSheet({
      title: '添加计划',
      render: () => ({ body: buildAddPlanBody(), actions: addPlanActions() }),
    });
  }

  async function submitAddPlan() {
    const title = el['plan-input'].value.trim();
    if (!title) {
      closeSheet();
      el['plan-input'].focus();
      return;
    }

    if (addPlanState.rule === 'weekly' && addPlanState.weekdays.size === 0) {
      toast('请至少选择一个重复的星期。', 'error');
      return;
    }

    setSheetBusy(true);

    try {
      let dashboard;

      if (addPlanState.rule === 'once') {
        dashboard = await api('/api/plans', { method: 'POST', body: { title } });
        toast('已加入今日计划。');
      } else {
        dashboard = await api('/api/recurring-plans', {
          method: 'POST',
          body: {
            title,
            rule: addPlanState.rule,
            weekdays: [...addPlanState.weekdays],
          },
        });
        toast(
          addPlanState.rule === 'daily'
            ? '已添加每天重复的计划。'
            : `已添加${weekdaysLabel([...addPlanState.weekdays])}的计划。`
        );
      }

      applyDashboard(dashboard);
      el['plan-input'].value = '';
      setSheetBusy(false);
      closeSheet();
      el['plan-input'].focus();
    } catch (error) {
      setSheetBusy(false);
      toast(error.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 重复计划管理                                                       */
  /* ---------------------------------------------------------------- */

  function sheetRow({ label, hint, tone, onClick }) {
    const row = make('button', `sheet-row${tone ? ` is-${tone}` : ''}`);
    row.type = 'button';
    const copy = make('span', 'sheet-row-copy');
    copy.appendChild(make('span', 'sheet-row-label', label));
    if (hint) copy.appendChild(make('span', 'sheet-row-hint', hint));
    row.append(copy, iconUse('icon-arrow'));
    row.addEventListener('click', onClick);
    return row;
  }

  function findRecurringRow(id) {
    if (!state.dashboard) return null;
    return state.dashboard.recurring.find((row) => row.id === id) || null;
  }

  function buildRecurringBody(row) {
    const frag = document.createDocumentFragment();

    const summary = make('div', 'sheet-summary');
    summary.appendChild(make('p', 'sheet-summary-title', row.title));

    const parts = [row.recurrenceLabel];
    if (row.ended) parts.push('已结束');
    else if (row.paused) parts.push('已暂停');
    else parts.push('进行中');
    if (row.endDate) parts.push(`至 ${row.endDate}`);
    summary.appendChild(make('p', 'sheet-summary-meta', parts.join(' · ')));
    frag.appendChild(summary);

    const list = make('div', 'sheet-list');

    if (row.dueToday) {
      if (row.skippedToday) {
        list.appendChild(
          sheetRow({
            label: '恢复今天',
            hint: '把今天重新放回列表',
            onClick: () => setRecurringSkip(row, false),
          })
        );
      } else {
        list.appendChild(
          sheetRow({
            label: '跳过今天',
            hint: '今天不再显示这一项',
            onClick: () => setRecurringSkip(row, true),
          })
        );
      }
    }

    if (!row.ended) {
      list.appendChild(
        sheetRow({
          label: row.paused ? '恢复重复' : '暂停重复',
          hint: row.paused ? '重新出现在每日计划里' : '暂时不再自动出现',
          onClick: () => setRecurringPaused(row, !row.paused),
        })
      );
    }

    frag.appendChild(list);

    const field = make('div', 'sheet-field');
    const label = make('label', 'sheet-field-label', '结束日期');
    label.setAttribute('for', 'recurring-end-date');

    const input = document.createElement('input');
    input.type = 'date';
    input.id = 'recurring-end-date';
    input.className = 'sheet-date';
    input.min = row.startDate;
    input.value = row.endDate || '';

    const save = make('button', 'sheet-inline-button', '保存');
    save.type = 'button';
    save.addEventListener('click', () => setRecurringEndDate(row, input.value));

    const line = make('div', 'sheet-date-row');
    line.append(input, save);

    field.append(label, line, make('p', 'sheet-hint', '留空表示一直重复。'));
    frag.appendChild(field);

    const danger = make('button', 'sheet-row is-danger', '删除整个重复计划');
    danger.type = 'button';
    danger.appendChild(iconUse('icon-trash'));
    danger.addEventListener('click', () => removeRecurring(row));
    frag.appendChild(danger);

    return frag;
  }

  function openRecurringSheet(plan) {
    const row = findRecurringRow(plan.id) || plan;
    openSheet({
      title: '重复计划',
      render: () => ({
        body: buildRecurringBody(row),
        actions: [{ label: '完成', primary: true, onClick: closeSheet }],
      }),
    });
  }

  async function setRecurringSkip(row, skipped) {
    setSheetBusy(true);
    try {
      const dashboard = await api(`/api/recurring-plans/${row.id}/skip`, {
        method: 'POST',
        body: { skipped },
      });
      applyDashboard(dashboard);
      toast(skipped ? '今天已跳过这一项。' : '今天已恢复这一项。');
      refreshRecurringSheet(row.id);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setSheetBusy(false);
    }
  }

  async function setRecurringPaused(row, paused) {
    setSheetBusy(true);
    try {
      const dashboard = await api(`/api/recurring-plans/${row.id}`, {
        method: 'PATCH',
        body: { paused },
      });
      applyDashboard(dashboard);
      toast(paused ? '已暂停这条重复计划。' : '已恢复这条重复计划。');
      refreshRecurringSheet(row.id);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setSheetBusy(false);
    }
  }

  async function setRecurringEndDate(row, value) {
    setSheetBusy(true);
    try {
      const dashboard = await api(`/api/recurring-plans/${row.id}`, {
        method: 'PATCH',
        body: { endDate: value || null },
      });
      applyDashboard(dashboard);
      toast(value ? `已设置结束日期：${value}` : '已取消结束日期。');
      refreshRecurringSheet(row.id);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setSheetBusy(false);
    }
  }

  async function removeRecurring(row) {
    if (!window.confirm(`删除“${row.title}”的整个重复计划？已完成的记录也会一起删除。`)) {
      return;
    }

    setSheetBusy(true);
    try {
      const dashboard = await api(`/api/recurring-plans/${row.id}`, {
        method: 'DELETE',
      });
      applyDashboard(dashboard);
      closeSheet();
      toast('重复计划已删除。');
    } catch (error) {
      toast(error.message, 'error');
      setSheetBusy(false);
    }
  }

  function refreshRecurringSheet(id) {
    const row = findRecurringRow(id);
    if (!row) {
      closeSheet();
      return;
    }
    // 复用同一个弹层，直接替换渲染函数里的数据。
    const currentTitle = el['sheet-title'].textContent;
    openSheet({
      title: currentTitle,
      render: () => ({
        body: buildRecurringBody(row),
        actions: [{ label: '完成', primary: true, onClick: closeSheet }],
      }),
    });
  }

  function buildManageBody() {
    const frag = document.createDocumentFragment();
    const rows = state.dashboard ? state.dashboard.recurring : [];

    if (rows.length === 0) {
      frag.appendChild(
        make('p', 'sheet-hint', '还没有重复计划。在“计划”页输入内容后点 + 就能创建。')
      );
      return frag;
    }

    const list = make('div', 'manage-list');

    for (const row of rows) {
      const item = make('div', 'manage-item');

      const copy = make('div', 'manage-copy');
      copy.appendChild(make('p', 'manage-title', row.title));

      const metaParts = [row.recurrenceLabel];
      if (row.skippedToday) metaParts.push('今天已跳过');
      else if (row.completedToday) metaParts.push('今天已完成');
      if (row.ended) metaParts.push('已结束');
      else if (row.paused) metaParts.push('已暂停');
      if (row.endDate) metaParts.push(`至 ${row.endDate}`);
      copy.appendChild(make('p', 'manage-meta', metaParts.join(' · ')));

      const open = make('button', 'manage-open', '详情');
      open.type = 'button';
      open.addEventListener('click', () => openRecurringSheet(row));

      item.append(copy, open);
      list.appendChild(item);
    }

    frag.appendChild(list);
    return frag;
  }

  function openRecurringManage() {
    openSheet({
      title: '重复计划',
      render: () => ({
        body: buildManageBody(),
        actions: [{ label: '完成', primary: true, onClick: closeSheet }],
      }),
    });
  }

  /* ---------------------------------------------------------------- */
  /* 修改访问密钥                                                       */
  /* ---------------------------------------------------------------- */

  function fieldRow(labelText, inputId, autocomplete) {
    const field = make('div', 'sheet-field');
    const label = make('label', 'sheet-field-label', labelText);
    label.setAttribute('for', inputId);

    const input = document.createElement('input');
    input.type = 'password';
    input.id = inputId;
    input.className = 'sheet-input';
    input.autocomplete = autocomplete;
    input.spellcheck = false;
    input.autocapitalize = 'none';
    input.maxLength = 128;
    input.required = true;

    field.append(label, input);
    return field;
  }

  function buildChangeKeyBody() {
    const frag = document.createDocumentFragment();
    frag.appendChild(
      make(
        'p',
        'sheet-hint',
        '服务端只保存 scrypt 哈希，不保存明文。修改后其他设备需要重新登录。'
      )
    );
    frag.appendChild(fieldRow('当前密钥', 'key-current', 'current-password'));
    frag.appendChild(fieldRow('新密钥（至少 8 位）', 'key-new', 'new-password'));
    frag.appendChild(fieldRow('确认新密钥', 'key-confirm', 'new-password'));
    return frag;
  }

  function openChangeKeySheet() {
    openSheet({
      title: '修改访问密钥',
      render: () => ({
        body: buildChangeKeyBody(),
        actions: [
          { label: '取消', onClick: closeSheet },
          { label: '保存', primary: true, onClick: submitChangeKey },
        ],
      }),
    });
  }

  async function submitChangeKey() {
    const current = document.getElementById('key-current');
    const next = document.getElementById('key-new');
    const confirm = document.getElementById('key-confirm');

    if (!current || !next || !confirm) return;

    const currentValue = current.value;
    const nextValue = next.value;

    if (!currentValue) {
      toast('请输入当前访问密钥。', 'error');
      current.focus();
      return;
    }
    if (nextValue.length < 8) {
      toast('新密钥至少需要 8 位。', 'error');
      next.focus();
      return;
    }
    if (nextValue !== confirm.value) {
      toast('两次输入的新密钥不一致。', 'error');
      confirm.focus();
      return;
    }

    setSheetBusy(true);
    try {
      await api('/api/auth/key', {
        method: 'POST',
        body: { currentKey: currentValue, newKey: nextValue },
        silent401: true,
      });
      closeSheet();
      toast('访问密钥已更新，其他设备需要重新登录。');
    } catch (error) {
      setSheetBusy(false);
      toast(error.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 登录 / 视图切换                                                   */
  /* ---------------------------------------------------------------- */

  function showLogin(message = '') {
    state.authenticated = false;
    state.dashboard = null;
    closeSheet();
    clearFocusLocal();
    el['app-view'].hidden = true;
    el['login-view'].hidden = false;
    el['boot-screen'].hidden = true;
    document.body.classList.remove('is-booting');
    document.title = '登录 · yOA';
    setLoginError(message);
    setLoginLoading(false);
    el['access-key'].value = '';
  }

  function showApp() {
    state.authenticated = true;
    el['login-view'].hidden = true;
    el['app-view'].hidden = false;
    setLoginError('');

    const requested = window.location.hash.replace('#', '');
    const initialPage = VALID_HASH.has(requested) ? requested : 'plan';
    switchPage(initialPage, { updateHash: !VALID_HASH.has(requested) });
  }

  function expireSession() {
    showLogin('登录已失效，请重新输入访问密钥。');
    toast('登录已失效，请重新登录。', 'error');
  }

  function applyDashboard(dashboard) {
    state.dashboard = dashboard;
    renderDashboard();
  }

  async function loadDashboard({ syncFocus = false } = {}) {
    const dashboard = await api('/api/dashboard');
    applyDashboard(dashboard);
    if (syncFocus) syncFocusWithServer(dashboard);
    return dashboard;
  }

  function renderDashboard() {
    renderDate();
    renderPlans();
    renderSupervision();
  }

  function renderDate() {
    if (!state.dashboard) return;
    el['top-date'].textContent = todayLabel(state.dashboard.today);
  }

  function renderPlans() {
    if (!state.dashboard) return;

    const plans = state.dashboard.plans;
    const total = plans.length;
    const completed = plans.filter((plan) => plan.completed).length;
    const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

    el['plan-percent'].textContent = String(percent);
    el['plan-progress-text'].textContent = `${completed} / ${total}`;
    el['plan-count'].textContent = `${total} 项`;
    el['plan-progress-bar'].style.width = `${percent}%`;
    el['plan-progress-track'].setAttribute('aria-valuenow', String(percent));

    let copy = '还没有计划，从第一件小事开始。';
    if (total > 0 && percent === 100) {
      copy = '今天的计划全部完成，可以放心收工。';
    } else if (total > 0 && percent >= 50) {
      copy = '已经走过一半，再往前一点。';
    } else if (total > 0 && completed > 0) {
      copy = `完成了 ${completed} 项，节奏不错。`;
    } else if (total > 0) {
      copy = `今天有 ${total} 件事，慢慢来。`;
    }
    el['plan-progress-copy'].textContent = copy;

    const fragment = document.createDocumentFragment();
    for (const plan of plans) {
      fragment.appendChild(createPlanItem(plan));
    }
    el['plan-list'].replaceChildren(fragment);
    el['plan-empty'].hidden = total > 0;

    const recurring = state.dashboard.recurring || [];
    const activeRecurring = recurring.filter((row) => !row.ended).length;
    el['recurring-manage'].hidden = recurring.length === 0;
    el['recurring-count'].textContent = String(activeRecurring);
  }

  function createPlanItem(plan) {
    const item = make('li', `plan-item${plan.completed ? ' is-completed' : ''}`);
    item.dataset.key = plan.key;

    const check = make('button', 'plan-check');
    check.type = 'button';
    check.dataset.action = 'toggle';
    check.setAttribute('aria-pressed', String(plan.completed));
    check.setAttribute(
      'aria-label',
      plan.completed ? `将“${plan.title}”标记为未完成` : `完成“${plan.title}”`
    );
    check.appendChild(iconUse('icon-check'));

    const content = make('div', 'plan-content');
    content.appendChild(make('p', 'plan-text', plan.title));

    if (plan.source === 'recurring') {
      const badge = make('span', 'plan-badge');
      badge.appendChild(iconUse('icon-repeat'));
      badge.appendChild(document.createTextNode(plan.recurrenceLabel));
      content.appendChild(badge);
    }

    const remove = make('button', 'plan-delete');
    remove.type = 'button';
    remove.dataset.action = 'delete';
    remove.setAttribute(
      'aria-label',
      plan.source === 'recurring'
        ? `管理重复计划“${plan.title}”`
        : `删除“${plan.title}”`
    );
    remove.appendChild(iconUse(plan.source === 'recurring' ? 'icon-more' : 'icon-trash'));

    item.append(check, content, remove);
    return item;
  }

  function renderSupervision() {
    if (!state.dashboard) return;

    const { stats, checkin } = state.dashboard;
    el['stat-focus'].textContent = String(stats.focusMinutes);
    el['stat-streak'].textContent = String(stats.streak);
    el['stat-completed'].textContent = String(stats.completed);

    if (stats.checkedIn) {
      el['checkin-button'].hidden = true;
      el['checkin-stamp'].hidden = false;
      el['checkin-button'].disabled = false;
      const time = timeLabel(checkin && checkin.createdAt);
      el.checkinStampText.textContent = time ? `已打卡 · ${time}` : '已打卡';
      el['checkin-hint'].textContent =
        stats.streak > 1
          ? `已连续打卡 ${stats.streak} 天，保持住。`
          : '今天已经留下脚印，明天见。';
    } else {
      el['checkin-button'].hidden = false;
      el['checkin-stamp'].hidden = true;
      el['checkin-button'].disabled = false;
      el['checkin-button'].textContent = '今日打卡';
      el['checkin-hint'].textContent = '留下一个脚印，让坚持变得看得见。';
    }
  }

  /* ---------------------------------------------------------------- */
  /* 计划操作                                                          */
  /* ---------------------------------------------------------------- */

  async function togglePlanEntry(plan, button) {
    button.disabled = true;

    try {
      const dashboard =
        plan.source === 'recurring'
          ? await api(`/api/recurring-plans/${plan.id}/occurrence`, {
              method: 'PATCH',
              body: { completed: !plan.completed },
            })
          : await api(`/api/plans/${plan.id}`, {
              method: 'PATCH',
              body: { completed: !plan.completed },
            });

      applyDashboard(dashboard);
      if (!plan.completed) toast('完成一件，做得不错。');
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  }

  async function deletePlanEntry(plan, button) {
    if (plan.source === 'recurring') {
      openRecurringSheet(plan);
      return;
    }

    if (!window.confirm(`删除“${plan.title}”？`)) return;

    button.disabled = true;
    try {
      const dashboard = await api(`/api/plans/${plan.id}`, { method: 'DELETE' });
      applyDashboard(dashboard);
      toast('计划已删除。');
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  }

  async function checkIn() {
    if (state.dashboard && state.dashboard.stats.checkedIn) return;

    el['checkin-button'].disabled = true;
    el['checkin-button'].textContent = '正在打卡…';

    try {
      const dashboard = await api('/api/checkins', { method: 'POST' });
      applyDashboard(dashboard);
      toast(`打卡成功，已连续 ${dashboard.stats.streak} 天。`);
    } catch (error) {
      el['checkin-button'].disabled = false;
      el['checkin-button'].textContent = '今日打卡';
      toast(error.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 专注计时（服务端权威）                                             */
  /* ---------------------------------------------------------------- */

  function formatClock(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(safe / 60);
    const seconds = safe % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function updateFocusUI() {
    const focus = state.focus;
    const ratio = focus.duration > 0 ? focus.remaining / focus.duration : 0;

    el['focus-time'].textContent = formatClock(focus.remaining);
    el['focus-fill'].style.strokeDasharray = `${FOCUS_CIRCUMFERENCE} ${FOCUS_CIRCUMFERENCE}`;
    el['focus-fill'].style.strokeDashoffset = String(
      FOCUS_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, ratio)))
    );

    let stateLabel = '准备开始';
    if (focus.running) stateLabel = '专注中';
    else if (focus.remaining === 0) stateLabel = '已完成';
    else if (focus.remaining < focus.duration) stateLabel = '已暂停';

    el['focus-state'].textContent = stateLabel;
    el['focus-state'].classList.toggle('is-running', focus.running);

    if (focus.running) {
      el['focus-start'].textContent = '暂停';
    } else if (focus.remaining === 0) {
      el['focus-start'].textContent = '再来一轮';
    } else if (focus.remaining < focus.duration) {
      el['focus-start'].textContent = '继续专注';
    } else {
      el['focus-start'].textContent = '开始专注';
    }

    for (const button of el.presetButtons) {
      const selected = Number(button.dataset.minutes) * 60 === focus.duration;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = focus.running;
    }
  }

  function clearFocusInterval() {
    if (state.focus.intervalId !== null) {
      window.clearInterval(state.focus.intervalId);
      state.focus.intervalId = null;
    }
  }

  function startFocusInterval() {
    clearFocusInterval();
    state.focus.intervalId = window.setInterval(tickFocus, 250);
  }

  function persistFocus() {
    const focus = state.focus;

    if (focus.running && focus.endAt > 0) {
      writeStore(FOCUS_STORAGE, {
        duration: focus.duration,
        planned: focus.planned,
        endAt: focus.endAt,
        sessionId: focus.sessionId,
      });
    } else {
      writeStore(FOCUS_STORAGE, null);
    }
  }

  function clearFocusLocal() {
    clearFocusInterval();
    state.focus.running = false;
    state.focus.sessionId = null;
    state.focus.endAt = 0;
    state.focus.planned = state.focus.duration;
    state.focus.remaining = state.focus.duration;
    writeStore(FOCUS_STORAGE, null);
    if (el['focus-time']) updateFocusUI();
  }

  function readNotified() {
    const value = readStore(NOTIFIED_STORAGE);
    return Array.isArray(value) ? value : [];
  }

  function markNotified(key) {
    if (!key) return false;
    const list = readNotified();
    if (list.includes(key)) return false;
    const next = [...list, key].slice(-MAX_NOTIFIED);
    writeStore(NOTIFIED_STORAGE, next);
    return true;
  }

  async function ensureNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;

    try {
      const result = await Notification.requestPermission();
      return result === 'granted';
    } catch {
      return false;
    }
  }

  function serviceWorkerReady(timeoutMs = 2000) {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);

    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
    ]).catch(() => null);
  }

  async function announceCompletion(durationSeconds, { sessionId = null, silent = false } = {}) {
    const minutes = Math.max(1, Math.round(durationSeconds / 60));
    const key = sessionId ? `session:${sessionId}` : null;

    if (key && !markNotified(key)) return;

    if ('Notification' in window && Notification.permission === 'granted') {
      const options = {
        body: `这一轮 ${minutes} 分钟已经记录。`,
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        tag: 'yoa-focus',
        renotify: true,
        lang: 'zh-CN',
      };

      try {
        const registration = await serviceWorkerReady();

        if (registration && typeof registration.showNotification === 'function') {
          await registration.showNotification('专注完成', options);
        } else {
          new Notification('专注完成', options);
        }
      } catch {
        // iOS 未安装到主屏幕等情况下会抛错，退回页面内提示。
      }
    }

    if (!silent) toast(`专注完成，已记录 ${minutes} 分钟。`);
  }

  function applyServerSession(session, { duration = 0 } = {}) {
    const stored = readStore(FOCUS_STORAGE);
    const suggested =
      stored && stored.sessionId === session.id && Number(stored.duration) > 0
        ? Number(stored.duration)
        : Number(session.plannedSeconds) || state.focus.duration;

    state.focus.duration = Number(duration) > 0 ? Number(duration) : suggested;
    state.focus.planned = Number(session.plannedSeconds) || 0;
    state.focus.sessionId = session.id;
    state.focus.endAt = Date.parse(session.endsAt);
    state.focus.remaining = Math.max(0, Number(session.remainingSeconds) || 0);
    state.focus.running = true;
    startFocusInterval();
    updateFocusUI();
    persistFocus();
  }

  function restoreLocalFocus() {
    const stored = readStore(FOCUS_STORAGE);
    if (!stored || !stored.endAt) return;

    const remaining = Math.max(0, Math.ceil((stored.endAt - Date.now()) / 1000));
    if (remaining <= 0) return;

    state.focus.duration = Number(stored.duration) || state.focus.duration;
    state.focus.planned = Number(stored.planned) || state.focus.duration;
    state.focus.sessionId = stored.sessionId || null;
    state.focus.endAt = stored.endAt;
    state.focus.remaining = remaining;
    state.focus.running = true;
    startFocusInterval();
    updateFocusUI();
  }

  function syncFocusWithServer(dashboard) {
    // 结算请求还在路上时不要用旧的 running 会话覆盖本地状态。
    if (state.focus.finishing) return;

    const active = dashboard.focus;

    if (active) {
      if (!state.focus.running || state.focus.sessionId !== active.id) {
        applyServerSession(active);
      } else {
        state.focus.endAt = Date.parse(active.endsAt);
        state.focus.remaining = Math.max(0, Number(active.remainingSeconds) || 0);
        updateFocusUI();
      }
      return;
    }

    if (state.focus.running) {
      clearFocusInterval();
      state.focus.running = false;
      state.focus.sessionId = null;
      state.focus.endAt = 0;
      state.focus.remaining = 0;
      updateFocusUI();
      persistFocus();
    }

    const stored = readStore(FOCUS_STORAGE);
    if (stored && stored.endAt) {
      const finished = stored.endAt <= Date.now();
      writeStore(FOCUS_STORAGE, null);

      if (finished) {
        const planned = Number(stored.planned) || Number(stored.duration) || 0;
        announceCompletion(planned, { sessionId: stored.sessionId });
        state.focus.remaining = 0;
        updateFocusUI();
      }
    }
  }

  async function flushPendingStop() {
    const pending = readStore(PENDING_STOP);
    if (!pending || !pending.sessionId) return;

    try {
      await api(`/api/focus-sessions/${pending.sessionId}`, {
        method: 'POST',
        body: { action: 'abort', stoppedAt: pending.stoppedAt },
      });
      writeStore(PENDING_STOP, null);
    } catch {
      // 下次启动再试。
    }
  }

  async function startFocus() {
    if (state.focus.running || state.focus.finishing) return;

    const remaining =
      state.focus.remaining > 0 ? state.focus.remaining : state.focus.duration;

    if (remaining <= 0) return;

    // 从暂停状态继续时保留原始总时长，圆环比例才不会跳回 100%。
    const resuming = remaining < state.focus.duration;
    const originalDuration = state.focus.duration;

    ensureNotificationPermission();

    try {
      const result = await api('/api/focus-sessions', {
        method: 'POST',
        body: { durationSeconds: remaining },
      });

      applyServerSession(result.session, {
        duration: resuming ? originalDuration : remaining,
      });

      if (result.dashboard) applyDashboard(result.dashboard);
      toast('开始专注，锁屏或切到后台也会继续计时。');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function pauseFocus() {
    if (!state.focus.running) return;

    const sessionId = state.focus.sessionId;
    const stoppedAt = new Date().toISOString();
    const remaining = Math.max(0, Math.ceil((state.focus.endAt - Date.now()) / 1000));

    clearFocusInterval();
    state.focus.running = false;
    state.focus.remaining = remaining;
    state.focus.sessionId = null;
    state.focus.endAt = 0;
    persistFocus();
    updateFocusUI();

    if (!sessionId) return;

    try {
      const result = await api(`/api/focus-sessions/${sessionId}`, {
        method: 'POST',
        body: { action: 'abort', stoppedAt },
      });

      if (result.dashboard) applyDashboard(result.dashboard);

      const recorded = Number(result.settled && result.settled.durationSeconds) || 0;
      if (recorded > 0) {
        toast(`已记录 ${Math.round(recorded / 60)} 分钟专注。`);
      } else if (remaining > 0) {
        toast('本次不足 5 秒，没有记录。');
      }
    } catch {
      writeStore(PENDING_STOP, { sessionId, stoppedAt });
      toast('网络异常，暂停记录会在下次联网时同步。', 'error');
    }
  }

  async function resetFocus() {
    if (state.focus.running) {
      await pauseFocus();
    }

    state.focus.remaining = state.focus.duration;
    state.focus.planned = state.focus.duration;
    state.focus.endAt = 0;
    state.focus.sessionId = null;
    persistFocus();
    updateFocusUI();
  }

  async function completeFocus() {
    if (!state.focus.running || state.focus.finishing) return;

    const sessionId = state.focus.sessionId;
    const duration = state.focus.duration;

    state.focus.finishing = true;
    clearFocusInterval();
    state.focus.running = false;
    state.focus.remaining = 0;
    state.focus.sessionId = null;
    state.focus.endAt = 0;
    persistFocus();
    updateFocusUI();

    try {
      if (sessionId) {
        const result = await api(`/api/focus-sessions/${sessionId}`, {
          method: 'POST',
          body: { action: 'complete' },
        });
        if (result.dashboard) applyDashboard(result.dashboard);
      }
      await announceCompletion(duration, { sessionId });
    } catch {
      await announceCompletion(duration, { sessionId });
      toast('专注完成，记录会在联网后自动补上。', 'error');
    } finally {
      state.focus.finishing = false;
    }
  }

  function tickFocus() {
    if (!state.focus.running) return;

    const remaining = Math.max(0, Math.ceil((state.focus.endAt - Date.now()) / 1000));

    if (remaining !== state.focus.remaining) {
      state.focus.remaining = remaining;
      updateFocusUI();
    }

    if (remaining <= 0) completeFocus();
  }

  function selectPreset(minutes) {
    if (state.focus.running) return;
    const duration = minutes * 60;
    state.focus.duration = duration;
    state.focus.planned = duration;
    state.focus.remaining = duration;
    state.focus.endAt = 0;
    persistFocus();
    updateFocusUI();
  }

  /* ---------------------------------------------------------------- */
  /* 页面切换                                                          */
  /* ---------------------------------------------------------------- */

  function switchPage(page, { updateHash = true } = {}) {
    const nextPage = VALID_HASH.has(page) ? page : 'plan';
    state.activePage = nextPage;

    for (const panel of el.pages) {
      const active = panel.dataset.page === nextPage;
      panel.classList.toggle('is-active', active);
      panel.setAttribute('aria-hidden', String(!active));
    }

    for (const tab of el.tabs) {
      const active = tab.dataset.page === nextPage;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    }

    if (updateHash && window.location.hash !== `#${nextPage}`) {
      window.history.replaceState(null, '', `#${nextPage}`);
    }

    document.title = `${PAGE_TITLES[nextPage]} · yOA`;
    window.scrollTo(0, 0);
  }

  /* ---------------------------------------------------------------- */
  /* 登录 / 登出                                                       */
  /* ---------------------------------------------------------------- */

  async function handleLogin(event) {
    event.preventDefault();
    const key = el['access-key'].value;

    if (!key) {
      setLoginError('请输入访问密钥。');
      shakeLoginForm();
      el['access-key'].focus();
      return;
    }

    setLoginError('');
    setLoginLoading(true);

    try {
      await api('/api/login', { method: 'POST', body: { key } });
    } catch (error) {
      setLoginError(error.message);
      shakeLoginForm();
      el['access-key'].select();
      setLoginLoading(false);
      return;
    }

    setLoginLoading(false);
    el['access-key'].value = '';
    showApp();
    restoreLocalFocus();

    try {
      await flushPendingStop();
      await loadDashboard({ syncFocus: true });
    } catch (error) {
      if (state.authenticated) toast(error.message, 'error');
    }
  }

  async function handleLogout() {
    if (!window.confirm('退出当前登录？')) return;

    if (state.focus.running) {
      try {
        await pauseFocus();
      } catch {
        // 即使同步失败也继续退出。
      }
    }

    try {
      await api('/api/logout', { method: 'POST', silent401: true });
    } catch {
      // The local session is cleared even if the request cannot reach the server.
    }

    showLogin();
    toast('已退出登录。');
  }

  function toggleKeyVisibility() {
    const reveal = el['access-key'].type === 'password';
    el['access-key'].type = reveal ? 'text' : 'password';
    el['toggle-key'].setAttribute('aria-pressed', String(reveal));
    el['toggle-key'].setAttribute('aria-label', reveal ? '隐藏密钥' : '显示密钥');
    el.eyeOpen.hidden = reveal;
    el.eyeOff.hidden = !reveal;
  }

  /* ---------------------------------------------------------------- */
  /* 事件绑定                                                          */
  /* ---------------------------------------------------------------- */

  function bindEvents() {
    el['login-form'].addEventListener('submit', handleLogin);
    el['toggle-key'].addEventListener('click', toggleKeyVisibility);

    el['plan-form'].addEventListener('submit', (event) => {
      event.preventDefault();
      openAddPlanSheet();
    });

    el['plan-list'].addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;

      const item = button.closest('.plan-item');
      if (!item || !state.dashboard) return;

      const plan = state.dashboard.plans.find((entry) => entry.key === item.dataset.key);
      if (!plan) return;

      if (button.dataset.action === 'toggle') {
        togglePlanEntry(plan, button);
      } else if (button.dataset.action === 'delete') {
        deletePlanEntry(plan, button);
      }
    });

    el['recurring-manage'].addEventListener('click', openRecurringManage);
    el['change-key-button'].addEventListener('click', openChangeKeySheet);

    el['sheet-layer'].addEventListener('click', (event) => {
      if (event.target.closest('[data-sheet-close]')) closeSheet();
    });

    el['focus-start'].addEventListener('click', () => {
      if (state.focus.running) pauseFocus();
      else startFocus();
    });

    el['focus-reset'].addEventListener('click', resetFocus);

    for (const button of el.presetButtons) {
      button.addEventListener('click', () => {
        selectPreset(Number(button.dataset.minutes));
      });
    }

    el['checkin-button'].addEventListener('click', checkIn);
    el['logout-button'].addEventListener('click', handleLogout);

    for (const tab of el.tabs) {
      tab.addEventListener('click', () => switchPage(tab.dataset.page));
    }

    el.tabbar.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

      event.preventDefault();
      const currentIndex = el.tabs.findIndex(
        (tab) => tab.dataset.page === state.activePage
      );
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex = (currentIndex + direction + el.tabs.length) % el.tabs.length;
      const nextTab = el.tabs[nextIndex];
      nextTab.focus();
      switchPage(nextTab.dataset.page);
    });

    window.addEventListener('hashchange', () => {
      const page = window.location.hash.replace('#', '');
      if (state.authenticated && VALID_HASH.has(page) && page !== state.activePage) {
        switchPage(page, { updateHash: false });
      }
    });

    document.addEventListener('keydown', (event) => {
      if (!sheetState.open) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        closeSheet();
        return;
      }

      trapSheetFocus(event);
    });

    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;

      if (state.focus.running) tickFocus();
      if (!state.authenticated) return;

      try {
        await flushPendingStop();
        await loadDashboard({ syncFocus: true });
      } catch {
        // 网络抖动时保留当前界面即可。
      }
    });

    // iOS 从后台返回时可能走 bfcache，不会触发 visibilitychange。
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;

      if (state.focus.running) tickFocus();
      if (state.authenticated) {
        loadDashboard({ syncFocus: true }).catch(() => {});
      }
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // HTTP 或非安全上下文下注册失败，不影响主流程。
      });
    });
  }

  /* ---------------------------------------------------------------- */
  /* 启动                                                              */
  /* ---------------------------------------------------------------- */

  async function boot() {
    cacheElements();
    bindEvents();
    updateFocusUI();
    registerServiceWorker();
    restoreLocalFocus();

    try {
      const response = await fetch('/api/session', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      if (response.ok) {
        const session = await response.json().catch(() => null);

        if (session && session.authenticated) {
          showApp();
          try {
            await flushPendingStop();
            await loadDashboard({ syncFocus: true });
          } catch (error) {
            if (state.authenticated) toast(error.message, 'error');
          }
        } else {
          showLogin();
        }
      } else if (response.status === 401) {
        showLogin();
      } else {
        showLogin();
        toast('服务暂时不可用，请稍后再试。', 'error');
      }
    } catch {
      showLogin();
      toast('无法连接服务器，请确认后端已启动。', 'error');
    } finally {
      el['boot-screen'].hidden = true;
      document.body.classList.remove('is-booting');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
