const qs = (sel) => document.querySelector(sel);

let latestTrackedAgents = [];
let refreshTimer = null;
let countdownTimer = null;
let nextRefreshAt = null;
let lastRefreshAt = null;
let isRefreshing = false;
let eventSource = null;

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function fmtDate(value) {
  if (!value) return 'not seen yet';
  return new Date(value).toLocaleString();
}

function setRefreshState(kind, message) {
  const el = qs('#refreshStatus');
  el.textContent = message;
  el.className = `status-pill ${kind ? `status-${kind}` : ''}`.trim();
}

function setDashboardError(message = '') {
  const el = qs('#dashboardError');
  el.textContent = message;
  el.classList.toggle('hidden', !message);
}

function updateHeroStats({ agents = latestTrackedAgents, sessions = [] } = {}) {
  qs('#trackedAgentCountHero').textContent = String(agents.length || 0);
  qs('#sessionCountHero').textContent = String(sessions.length || 0);
}

function describeTimeUntilRefresh() {
  if (!qs('#autoRefreshToggle').checked) return 'Live sync paused';
  if (eventSource) return 'Live stream connected';
  if (!nextRefreshAt) return 'Waiting for next sync';
  const seconds = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  return `Polling again in ${seconds}s`;
}

function updateRefreshMeta() {
  const label = describeTimeUntilRefresh();
  const suffix = lastRefreshAt ? ` • Last updated ${lastRefreshAt.toLocaleTimeString()}` : '';
  qs('#nextRefresh').textContent = `${label}${suffix}`;
}

function clearRefreshTimers() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (countdownTimer) clearInterval(countdownTimer);
  refreshTimer = null;
  countdownTimer = null;
  nextRefreshAt = null;
}

function schedulePollingRefresh() {
  clearRefreshTimers();
  if (!qs('#autoRefreshToggle').checked || eventSource) {
    updateRefreshMeta();
    return;
  }
  const seconds = Number(qs('#refreshIntervalSelect').value || 10);
  nextRefreshAt = Date.now() + (seconds * 1000);
  refreshTimer = setTimeout(() => refreshAll({ silentLoading: true }), seconds * 1000);
  countdownTimer = setInterval(updateRefreshMeta, 1000);
  updateRefreshMeta();
}

function renderAgents(items) {
  latestTrackedAgents = items;
  qs('#trackedAgentCount').textContent = `${items.length} shown`;
  updateHeroStats({ agents: items });

  qs('#agentsTable').innerHTML = items.length ? `
    <div class="agent-grid">
      ${items.map((a) => `
        <article class="agent-card">
          <div class="agent-card-header">
            <div>
              <div class="pill">${a.id}</div>
              <h3>${a.label || a.id}</h3>
            </div>
            <div class="agent-status ${a.health}">${a.health.replace('-', ' ')}</div>
          </div>
          <div class="muted">${a.notes || ''}</div>
          <div class="metric-row">
            <div class="metric-box">
              <span>Sessions</span>
              <strong>${a.sessionCount}</strong>
            </div>
            <div class="metric-box">
              <span>Last hour</span>
              <strong>${a.activeLastHour}</strong>
            </div>
            <div class="metric-box">
              <span>Total tokens</span>
              <strong>${a.totalTokens}</strong>
            </div>
            <div class="metric-box">
              <span>Avg/session</span>
              <strong>${a.avgTokensPerSession}</strong>
            </div>
          </div>
          <div class="muted" style="margin-top: 12px;">Last seen: ${fmtDate(a.lastUpdatedAt)}</div>
          <div class="muted">Kind: ${a.lastKind || 'n/a'} • Models: ${(a.models || []).join(', ') || 'n/a'}</div>
        </article>`).join('')}
    </div>` : '<div class="muted">No tracked agents found</div>';
}

function renderSessions(items) {
  qs('#sessionCount').textContent = `${items.length} shown`;
  updateHeroStats({ sessions: items });

  qs('#sessionsTable').innerHTML = items.length ? `
    <div class="sessions-list">
      ${items.map((s) => `
        <article class="session-item">
          <div class="session-meta">
            <span class="pill">${s.agentId || 'unknown'}</span>
            <span class="pill">${s.kind || 'n/a'}</span>
            <span class="pill">${s.model || 'n/a'}</span>
          </div>
          <div class="code">${s.key}</div>
          <div class="muted" style="margin-top: 10px;">Updated ${fmtDate(s.updatedAt)}</div>
          <div class="muted">Total tokens: ${s.totalTokens || 0}</div>
        </article>`).join('')}
    </div>` : '<div class="muted">No sessions found</div>';
}

function applyProfileToTask(profile) {
  qs('#targetAgentId').value = profile.targetAgentId || 'main';
  qs('#thinkingSelect').value = profile.defaultThinking || 'low';
}

function renderProfiles(items) {
  const select = qs('#profileSelect');
  select.innerHTML = items.map((p) => `<option value="${p.id}">${p.label} → ${p.targetAgentId}</option>`).join('');
  const selected = items[0];
  if (selected) applyProfileToTask(selected);

  qs('#profilesList').innerHTML = items.map((p) => `
    <div class="profile-item">
      <strong>${p.label}</strong>
      <div class="muted code">id=${p.id} | target=${p.targetAgentId} | thinking=${p.defaultThinking}</div>
      <div>${p.notes || ''}</div>
      <div class="profile-actions">
        <button data-use="${p.id}">Use</button>
        <button data-delete="${p.id}">Delete</button>
      </div>
    </div>`).join('') || '<div class="muted">No profiles yet.</div>';

  qs('#profilesList').querySelectorAll('[data-use]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profile = items.find((x) => x.id === btn.dataset.use);
      if (profile) applyProfileToTask(profile);
    });
  });
  qs('#profilesList').querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/profiles/${encodeURIComponent(btn.dataset.delete)}`, { method: 'DELETE' });
      await loadProfiles();
    });
  });

  select.onchange = () => {
    const profile = items.find((x) => x.id === select.value);
    if (profile) applyProfileToTask(profile);
  };
}

function renderTrackedAgentList(items) {
  qs('#trackedAgentsList').innerHTML = items.map((a) => {
    const perf = latestTrackedAgents.find((p) => p.id === a.id);
    return `
      <div class="profile-item">
        <strong>${a.label}</strong>
        <div class="muted code">id=${a.id}</div>
        <div>${a.notes || ''}</div>
        <div class="muted">health=${perf?.health || 'unknown'} | sessions=${perf?.sessionCount || 0} | totalTokens=${perf?.totalTokens || 0}</div>
        <div class="profile-actions">
          <button data-watch-use="${a.id}">Target this agent</button>
          <button data-watch-delete="${a.id}">Delete</button>
        </div>
      </div>`;
  }).join('') || '<div class="muted">No tracked agents yet.</div>';

  qs('#trackedAgentsList').querySelectorAll('[data-watch-use]').forEach((btn) => {
    btn.addEventListener('click', () => {
      qs('#targetAgentId').value = btn.dataset.watchUse;
    });
  });
  qs('#trackedAgentsList').querySelectorAll('[data-watch-delete]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/agents/${encodeURIComponent(btn.dataset.watchDelete)}`, { method: 'DELETE' });
      await loadTrackedAgents();
      await loadDashboard();
    });
  });
}

function renderStreamSnapshot(payload) {
  const overview = payload.overview || {};
  renderAgents(overview.agents?.performance || []);
  renderSessions(overview.sessions?.recent || []);
  if (payload.trackedAgents) renderTrackedAgentList(payload.trackedAgents);
  lastRefreshAt = new Date();
  setDashboardError('');
  setRefreshState('ok', 'Live updates flowing');
  qs('#liveModeHero').textContent = 'connected';
  updateRefreshMeta();
}

async function loadDashboard() {
  const overview = await getJson('/api/overview');
  renderAgents(overview.agents?.performance || []);
  renderSessions(overview.sessions?.recent || []);
}

async function loadProfiles() {
  const profiles = await getJson('/api/profiles');
  renderProfiles(profiles.items || []);
}

async function loadTrackedAgents() {
  const tracked = await getJson('/api/agents');
  renderTrackedAgentList(tracked.items || []);
}

async function refreshAll({ silentLoading = false } = {}) {
  if (isRefreshing) return;
  isRefreshing = true;
  qs('#refreshBtn').disabled = true;
  if (!silentLoading) setRefreshState('loading', 'Refreshing dashboard…');

  try {
    await Promise.all([loadDashboard(), loadProfiles(), loadTrackedAgents()]);
    lastRefreshAt = new Date();
    setDashboardError('');
    setRefreshState('ok', eventSource ? 'Live updates flowing' : 'Dashboard synced');
  } catch (error) {
    setRefreshState('error', 'Refresh failed');
    setDashboardError(String(error.message || error));
    qs('#liveModeHero').textContent = 'degraded';
  } finally {
    isRefreshing = false;
    qs('#refreshBtn').disabled = false;
    schedulePollingRefresh();
    updateRefreshMeta();
  }
}

function closeLiveStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  qs('#liveModeHero').textContent = 'polling';
}

function startLiveStream() {
  closeLiveStream();
  if (!qs('#autoRefreshToggle').checked) {
    qs('#liveModeHero').textContent = 'paused';
    schedulePollingRefresh();
    return;
  }

  try {
    eventSource = new EventSource('/api/stream');
    qs('#liveModeHero').textContent = 'connecting';

    eventSource.onmessage = (event) => {
      renderStreamSnapshot(JSON.parse(event.data));
      clearRefreshTimers();
    };

    eventSource.onerror = () => {
      closeLiveStream();
      qs('#liveModeHero').textContent = 'polling';
      setRefreshState('loading', 'Live stream lost, falling back to polling');
      schedulePollingRefresh();
    };
  } catch (error) {
    closeLiveStream();
    setDashboardError(String(error.message || error));
    schedulePollingRefresh();
  }
}

qs('#refreshBtn').addEventListener('click', async () => {
  await refreshAll();
});

qs('#autoRefreshToggle').addEventListener('change', () => {
  if (!qs('#autoRefreshToggle').checked) {
    closeLiveStream();
    clearRefreshTimers();
    qs('#liveModeHero').textContent = 'paused';
    updateRefreshMeta();
    return;
  }
  startLiveStream();
  refreshAll({ silentLoading: true });
});

qs('#refreshIntervalSelect').addEventListener('change', () => {
  if (!eventSource) schedulePollingRefresh();
});

qs('#trackedAgentForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await getJson('/api/agents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: qs('#trackedAgentId').value,
      label: qs('#trackedAgentLabel').value,
      notes: qs('#trackedAgentNotes').value,
    })
  });
  event.target.reset();
  await loadTrackedAgents();
  await refreshAll({ silentLoading: true });
});

qs('#profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await getJson('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: qs('#profileId').value,
      label: qs('#profileLabel').value,
      targetAgentId: qs('#profileTargetAgentId').value,
      defaultThinking: qs('#profileThinking').value,
      notes: qs('#profileNotes').value,
    })
  });
  event.target.reset();
  qs('#profileThinking').value = 'low';
  await loadProfiles();
});

qs('#taskForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const resultBox = qs('#taskResult');
  resultBox.textContent = 'Sending task...';
  resultBox.className = 'pre small';
  try {
    const result = await getJson('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetAgentId: qs('#targetAgentId').value,
        thinking: qs('#thinkingSelect').value,
        message: qs('#taskMessage').value,
      })
    });
    resultBox.textContent = JSON.stringify(result, null, 2);
    resultBox.className = `pre small ${result.ok ? 'status-ok' : 'status-error'}`;
    await refreshAll({ silentLoading: true });
  } catch (error) {
    resultBox.textContent = String(error.message || error);
    resultBox.className = 'pre small status-error';
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    closeLiveStream();
    clearRefreshTimers();
    updateRefreshMeta();
    return;
  }
  startLiveStream();
  refreshAll({ silentLoading: true });
});

(async function init() {
  setRefreshState('loading', 'Loading dashboard…');
  await Promise.all([loadProfiles(), loadTrackedAgents()]);
  await refreshAll({ silentLoading: true });
  startLiveStream();
})();
