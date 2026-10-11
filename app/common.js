/* Shared page plumbing: config, API calls with the sign-in token, brand, toasts, formatting. Loaded after surveycx-core.js and surveycx-auth.js. */
(function () {
  'use strict';
  const cfg = window.SURVEYCX_CONFIG || {};
  // Light or dark: ?theme= wins, then what this browser chose before, else the system setting.
  try { const t = new URLSearchParams(location.search).get('theme') || localStorage.getItem('surveycx.theme'); if (t === 'light' || t === 'dark') { document.documentElement.setAttribute('data-theme', t); localStorage.setItem('surveycx.theme', t); } } catch {}
  const API = (cfg.api || '/api').replace(/\/$/, '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let toastTimer;
  function toast(msg, bad) { const t = document.getElementById('toast'); if (!t) return; t.textContent = msg; t.style.background = bad ? 'var(--bad)' : ''; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 5000 : 2500); }
  async function api(method, path, body, raw) {
    const headers = { 'content-type': 'application/json' };
    const token = window.SurveyCXAuth && SurveyCXAuth.enabled() ? await SurveyCXAuth.token() : null;
    if (token) headers.authorization = 'Bearer ' + token;
    const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (raw) return r;
    const data = r.headers.get('content-type') && r.headers.get('content-type').includes('json') ? await r.json() : { error: await r.text() };
    if (!r.ok) { const e = new Error(data.error || ('request failed: ' + r.status)); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  function applyBrand(brand) {
    if (!brand) return;
    if (brand.accent) { document.documentElement.style.setProperty('--accent', brand.accent); document.documentElement.style.setProperty('--accent-dark', brand.accent); }
    document.querySelectorAll('[data-brand-name]').forEach((el) => { el.textContent = brand.name || el.getAttribute('data-brand-name'); });
    document.querySelectorAll('[data-brand-logo]').forEach((el) => { if (brand.logoUrl) el.src = brand.logoUrl; });
  }
  const fmt = { n1: (v) => (v == null ? '–' : Number(v).toFixed(1)), pct: (v) => (v == null ? '–' : Math.round(v) + '%'), int: (v) => (v == null ? '–' : String(v)), day: (iso) => (iso ? String(iso).slice(0, 10) : ''), when: (iso) => (iso ? new Date(iso).toLocaleString() : '') };
  function viewer() { const c = window.SurveyCXAuth && SurveyCXAuth.enabled() ? SurveyCXAuth.claims() : null; return { supervisor: !c || SurveyCXAuth.isSupervisor(c) || !!cfg.demo, agentArn: c && c['custom:agentArn'], name: c && (c.name || c['cognito:username']) }; }
  async function ready() { if (window.SurveyCXAuth && SurveyCXAuth.enabled()) await SurveyCXAuth.ready(); if (cfg.demo && !window.SurveyCXDemo) await new Promise((res) => { const s = document.createElement('script'); s.src = 'demo.js'; s.onload = res; document.head.appendChild(s); }); }
  const signOut = document.getElementById('signout'); if (signOut) { if (!(window.SurveyCXAuth && SurveyCXAuth.enabled())) signOut.classList.add('hidden'); else signOut.onclick = () => SurveyCXAuth.logout(); }
  window.App = { cfg, API, esc, toast, api, applyBrand, fmt, viewer, ready };
})();
