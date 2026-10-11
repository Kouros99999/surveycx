/*
 * SurveyCX sign-in for the pages: OAuth2 authorization code + PKCE against the Cognito hosted UI.
 * No client secret, tokens in sessionStorage, refresh a minute before expiry.
 *
 * Config (window.SURVEYCX_CONFIG.auth): { domain: 'https://xxx.auth.<region>.amazoncognito.com', clientId: '...' }
 * Without that config the module is inert and the pages run as before.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SurveyCXAuth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const KEY = 'surveycx.tokens';

  function parseJwt(token) {
    try {
      const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const s = typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString('binary');
      return JSON.parse(decodeURIComponent(Array.from(s, (c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
    } catch { return null; }
  }
  function isSupervisor(claims) {
    const g = (claims && claims['cognito:groups']) || [];
    return (Array.isArray(g) ? g : String(g).split(/[ ,]+/)).includes('supervisors');
  }

  // Everything below needs a browser.
  if (typeof window === 'undefined') return { parseJwt, isSupervisor };

  const cfg = () => (window.SURVEYCX_CONFIG && window.SURVEYCX_CONFIG.auth) || null;
  const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const save = (t) => { try { t ? sessionStorage.setItem(KEY, JSON.stringify(t)) : sessionStorage.removeItem(KEY); } catch {} };
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const redirectUri = () => location.origin + location.pathname;

  async function pkce() {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    return { verifier, challenge };
  }

  async function login() {
    const c = cfg(); const { verifier, challenge } = await pkce();
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    sessionStorage.setItem('surveycx.pkce', JSON.stringify({ verifier, state, search: location.search }));
    const q = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: redirectUri(), scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256' });
    location.assign(c.domain.replace(/\/$/, '') + '/oauth2/authorize?' + q);
  }

  async function tokenRequest(params) {
    const c = cfg();
    const r = await fetch(c.domain.replace(/\/$/, '') + '/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.assign({ client_id: c.clientId }, params)) });
    if (!r.ok) throw new Error('token endpoint ' + r.status);
    const t = await r.json();
    const prev = load() || {};
    const out = { id: t.id_token, access: t.access_token, refresh: t.refresh_token || prev.refresh, exp: (parseJwt(t.id_token) || {}).exp || 0 };
    save(out); return out;
  }

  async function handleCallback() {
    const p = new URLSearchParams(location.search);
    const code = p.get('code'); if (!code) return false;
    const st = JSON.parse(sessionStorage.getItem('surveycx.pkce') || 'null'); sessionStorage.removeItem('surveycx.pkce');
    if (!st || st.state !== p.get('state')) throw new Error('sign-in state mismatch');
    await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: st.verifier });
    history.replaceState(null, '', location.pathname + (st.search || ''));   // drop ?code=..., restore the page's own query
    return true;
  }

  async function token() {
    let t = load();
    if (!t) return null;
    if (t.exp * 1000 - Date.now() < 60000) {
      if (!t.refresh) { save(null); return null; }
      try { t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }); }
      catch { save(null); return null; }
    }
    return t.id;
  }

  let readyPromise = null;
  /** Resolves with an id token, or redirects to sign in (never resolves in that case). Inert without config. */
  function ready() {
    if (!cfg()) return Promise.resolve(null);
    if (!readyPromise) readyPromise = (async () => {
      await handleCallback();
      const t = await token();
      if (t) return t;
      await login(); return new Promise(() => {});
    })();
    return readyPromise;
  }

  function claims() { const t = load(); return t ? parseJwt(t.id) : null; }
  function logout() {
    const c = cfg(); save(null);
    if (c) location.assign(c.domain.replace(/\/$/, '') + '/logout?' + new URLSearchParams({ client_id: c.clientId, logout_uri: location.origin + '/' }));
  }

  return { parseJwt, isSupervisor, ready, token, claims, logout, enabled: () => !!cfg() };
});
