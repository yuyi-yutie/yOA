(() => {
  'use strict';

  const PAGE_NAMES = ['plan', 'supervise', 'about'];
  const PAGE_TITLES = { plan: '计划', supervise: '监督', about: '关于' };
  const FOCUS_RADIUS = 86;
  const FOCUS_CIRCUMFERENCE = 2 * Math.PI * FOCUS_RADIUS;
  const VALID_HASH = new Set(PAGE_NAMES);

  const state = {
    authenticated: false,
    dashboard: null,
    activePage: 'plan',
    focus: {
      duration: 25 * 60,
      remaining: 25 * 60,
      endAt: 0,
      running: false,
      recorded: false,
      intervalId: null,
    },
    toastTimer: null,
  };

  const el = {};

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
      'logout-button',
      'toast',
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
    el.checkinStampText = el['checkin-stamp'] ? el['checkin-stamp'].querySelector('span') : null;
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

          const error = new Error(
            (data && data.error) || '请求失败，请稍后再试'
          );
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

  function showLogin(message = '') {
    state.authenticated = false;
    state.dashboard = null;
    resetFocus();
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

  function loadDashboard() {
    return api('/api/dashboard').then((dashboard) => {
      state.dashboard = dashboard;
      renderDashboard();
    });
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
  }

  function createPlanItem(plan) {
    const item = document.createElement('li');
    item.className = `plan-item${plan.completed ? ' is-completed' : ''}`;
    item.dataset.id = String(plan.id);

    const check = document.createElement('button');
    check.type = 'button';
    check.className = 'plan-check';
    check.dataset.action = 'toggle';
    check.setAttribute('aria-pressed', String(plan.completed));
    check.setAttribute(
      'aria-label',
      plan.completed ? `将“${plan.title}”标记为未完成` : `完成“${plan.title}”`
    );
    check.innerHTML = '<svg aria-hidden="true"><use href="#icon-check"></use></svg>';

    const text = document.createElement('p');
    text.className = 'plan-text';
    text.textContent = plan.title;

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'plan-delete';
    remove.dataset.action = 'delete';
    remove.setAttribute('aria-label', `删除“${plan.title}”`);
    remove.innerHTML = '<svg aria-hidden="true"><use href="#icon-trash"></use></svg>';

    item.append(check, text, remove);
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

  async function togglePlan(plan, button) {
    button.disabled = true;

    try {
      const dashboard = await api(`/api/plans/${plan.id}`, {
        method: 'PATCH',
        body: { completed: !plan.completed },
      });
      state.dashboard = dashboard;
      renderDashboard();
      if (!plan.completed) toast('完成一件，做得不错。');
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  }

  async function deletePlan(plan, button) {
    if (!window.confirm(`删除“${plan.title}”？`)) return;

    button.disabled = true;
    try {
      const dashboard = await api(`/api/plans/${plan.id}`, { method: 'DELETE' });
      state.dashboard = dashboard;
      renderDashboard();
      toast('计划已删除。');
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'error');
    }
  }

  async function addPlan() {
    const title = el['plan-input'].value.trim();
    if (!title) {
      el['plan-input'].focus();
      return;
    }

    el['add-plan-button'].disabled = true;
    try {
      const dashboard = await api('/api/plans', {
        method: 'POST',
        body: { title },
      });
      state.dashboard = dashboard;
      el['plan-input'].value = '';
      renderDashboard();
      el['plan-input'].focus();
      toast('已加入今日计划。');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      el['add-plan-button'].disabled = false;
    }
  }

  async function checkIn() {
    if (state.dashboard && state.dashboard.stats.checkedIn) return;

    el['checkin-button'].disabled = true;
    el['checkin-button'].textContent = '正在打卡…';

    try {
      const dashboard = await api('/api/checkins', { method: 'POST' });
      state.dashboard = dashboard;
      renderSupervision();
      toast(`打卡成功，已连续 ${dashboard.stats.streak} 天。`);
    } catch (error) {
      el['checkin-button'].disabled = false;
      el['checkin-button'].textContent = '今日打卡';
      toast(error.message, 'error');
    }
  }

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

  function startFocus() {
    if (state.focus.running) return;

    if (state.focus.remaining <= 0) {
      state.focus.remaining = state.focus.duration;
      state.focus.recorded = false;
    }

    state.focus.endAt = Date.now() + state.focus.remaining * 1000;
    state.focus.running = true;
    clearFocusInterval();
    state.focus.intervalId = window.setInterval(tickFocus, 250);
    updateFocusUI();
  }

  function pauseFocus() {
    if (!state.focus.running) return;

    const remaining = Math.max(
      0,
      Math.ceil((state.focus.endAt - Date.now()) / 1000)
    );

    if (remaining <= 0) {
      state.focus.remaining = 0;
      finishFocus();
      return;
    }

    state.focus.remaining = remaining;
    state.focus.running = false;
    clearFocusInterval();
    updateFocusUI();
  }

  function resetFocus() {
    clearFocusInterval();
    state.focus.running = false;
    state.focus.remaining = state.focus.duration;
    state.focus.recorded = false;
    state.focus.endAt = 0;
    if (el['focus-time']) updateFocusUI();
  }

  function tickFocus() {
    if (!state.focus.running) return;

    const remaining = Math.max(
      0,
      Math.ceil((state.focus.endAt - Date.now()) / 1000)
    );

    if (remaining !== state.focus.remaining) {
      state.focus.remaining = remaining;
      updateFocusUI();
    }

    if (remaining <= 0) finishFocus();
  }

  async function finishFocus() {
    if (!state.focus.running) return;

    const duration = state.focus.duration;
    state.focus.running = false;
    state.focus.remaining = 0;
    clearFocusInterval();
    updateFocusUI();

    if (state.focus.recorded) return;
    state.focus.recorded = true;

    try {
      const dashboard = await api('/api/focus-sessions', {
        method: 'POST',
        body: { durationSeconds: duration },
      });
      state.dashboard = dashboard;
      renderDashboard();
      toast(`专注 ${Math.round(duration / 60)} 分钟，已记录。`);
    } catch (error) {
      state.focus.recorded = false;
      toast(`专注完成，但记录失败：${error.message}`, 'error');
    }
  }

  function selectPreset(minutes) {
    if (state.focus.running) return;
    state.focus.duration = minutes * 60;
    state.focus.remaining = state.focus.duration;
    state.focus.recorded = false;
    state.focus.endAt = 0;
    updateFocusUI();
  }

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

    try {
      await loadDashboard();
    } catch (error) {
      if (state.authenticated) toast(error.message, 'error');
    }
  }

  async function handleLogout() {
    if (!window.confirm('退出当前登录？')) return;

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
    el['toggle-key'].setAttribute(
      'aria-label',
      reveal ? '隐藏密钥' : '显示密钥'
    );
    el.eyeOpen.hidden = reveal;
    el.eyeOff.hidden = !reveal;
  }

  function bindEvents() {
    el['login-form'].addEventListener('submit', handleLogin);
    el['toggle-key'].addEventListener('click', toggleKeyVisibility);

    el['plan-form'].addEventListener('submit', (event) => {
      event.preventDefault();
      addPlan();
    });

    el['plan-list'].addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;

      const item = button.closest('.plan-item');
      if (!item || !state.dashboard) return;

      const plan = state.dashboard.plans.find(
        (entry) => entry.id === Number(item.dataset.id)
      );
      if (!plan) return;

      if (button.dataset.action === 'toggle') {
        togglePlan(plan, button);
      } else if (button.dataset.action === 'delete') {
        deletePlan(plan, button);
      }
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
      const nextIndex =
        (currentIndex + direction + el.tabs.length) % el.tabs.length;
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

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.focus.running) {
        tickFocus();
      }
    });
  }

  async function boot() {
    cacheElements();
    bindEvents();
    updateFocusUI();

    try {
      const response = await fetch('/api/session', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });

      if (response.ok) {
        showApp();
        try {
          await loadDashboard();
        } catch (error) {
          if (state.authenticated) toast(error.message, 'error');
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
