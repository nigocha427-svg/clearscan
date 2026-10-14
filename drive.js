/* ClearScan — Google Drive 連携
 * Google Identity Services でアクセストークンを取得し、Drive API v3 で保存する。
 * スコープは drive.file(このアプリが作ったファイル・フォルダだけ触れる)。
 */
(function (root) {
  'use strict';

  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  let gisPromise = null;
  let tokenClient = null, clientIdUsed = '';
  let token = null, tokenExp = 0;

  function loadGIS() {
    if (root.google && root.google.accounts && root.google.accounts.oauth2) return Promise.resolve();
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Googleのログイン部品を読み込めませんでした')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

  const hasToken = () => token && Date.now() < tokenExp - 60000;

  /* ボタンのタップ内で呼ぶこと(ポップアップが開くため) */
  function authorize(clientId) {
    return new Promise((resolve, reject) => {
      if (hasToken()) return resolve(token);
      if (!root.google || !root.google.accounts) return reject(new Error('Googleのログイン部品がまだ読み込まれていません。もう一度お試しください'));
      if (!tokenClient || clientIdUsed !== clientId) {
        clientIdUsed = clientId;
        tokenClient = root.google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: () => {} });
      }
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        token = resp.access_token;
        tokenExp = Date.now() + (resp.expires_in || 3600) * 1000;
        resolve(token);
      };
      tokenClient.error_callback = (err) => reject(new Error(err && err.type === 'popup_closed' ? 'ログインがキャンセルされました' : 'ログインに失敗しました'));
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  async function api(url, init = {}) {
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    if (res.status === 401) { token = null; throw new Error('ログインの有効期限が切れました。もう一度保存してください'); }
    if (!res.ok) throw new Error(`Drive エラー (${res.status})`);
    return res.json();
  }

  async function ensureFolder(name, cachedId) {
    if (cachedId) {
      try {
        const f = await api(`https://www.googleapis.com/drive/v3/files/${cachedId}?fields=id,name,trashed`);
        if (!f.trashed && f.name === name) return f.id;
      } catch (_) { /* 作り直す */ }
    }
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const list = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&spaces=drive`);
    if (list.files && list.files.length) return list.files[0].id;
    const f = await api('https://www.googleapis.com/drive/v3/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
    });
    return f.id;
  }

  async function upload(blob, name, folderId) {
    const boundary = 'cs' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: folderId ? [folderId] : undefined });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ]);
    return api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  function signOut() {
    if (token && root.google && root.google.accounts) root.google.accounts.oauth2.revoke(token, () => {});
    token = null; tokenExp = 0;
  }

  root.Drive = { loadGIS, authorize, ensureFolder, upload, hasToken, signOut };
})(window);
