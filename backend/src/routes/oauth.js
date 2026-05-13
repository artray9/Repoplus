/**
 * OAuth2 для Facebook, Google Ads, TikTok, amoCRM.
 *
 * ДВА режима:
 *   1) PER-CLIENT (legacy): /facebook/init?client_id=UUID → токен сохраняется в integration_tokens
 *   2) DISCOVERY (новый):   /facebook/connect-init        → токен сохраняется в user_oauth_tokens,
 *                                                          фронт потом дёргает /api/sources/.../accounts
 *
 * Различие закодировано в state.mode = 'client' | 'discover'.
 */
const express = require('express');
const axios   = require('axios');
const jwt     = require('jsonwebtoken');
const { query } = require('../db');

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://repoplus.kz';
const BACKEND_URL  = process.env.BACKEND_URL  || 'https://repoplus-production.up.railway.app';

// JWT из ?token=... (для browser-redirect flow)
function authQuery(req, res, next) {
  const token = req.query.token;
  if (!token) return res.status(401).send('Unauthorized');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).send('Invalid token');
  }
}

function encodeState(data) {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}
function decodeState(state) {
  return JSON.parse(Buffer.from(state, 'base64url').toString());
}

async function saveUserToken(userId, source, accessToken, refreshToken, expiresAt, extra) {
  await query(
    `INSERT INTO user_oauth_tokens (user_id, source, access_token, refresh_token, expires_at, extra, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (user_id, source) DO UPDATE SET
       access_token=$3,
       refresh_token=COALESCE($4, user_oauth_tokens.refresh_token),
       expires_at=$5,
       extra=$6,
       updated_at=NOW()`,
    [userId, source, accessToken, refreshToken || null, expiresAt || null, JSON.stringify(extra || {})]
  );
}

async function saveClientToken(clientId, source, accessToken, refreshToken, expiresAt) {
  await query(
    `INSERT INTO integration_tokens (client_id, source, access_token, refresh_token, expires_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (client_id, source) DO UPDATE SET
       access_token=$3,
       refresh_token=COALESCE($4, integration_tokens.refresh_token),
       expires_at=$5, updated_at=NOW()`,
    [clientId, source, accessToken, refreshToken || null, expiresAt || null]
  );
}

// ════════════════════ FACEBOOK ════════════════════

router.get('/facebook/init', authQuery, (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).send('client_id required');
  const state = encodeState({ mode: 'client', clientId: client_id, userId: req.user.userId, ts: Date.now() });
  const params = new URLSearchParams({
    client_id:     process.env.FB_APP_ID,
    redirect_uri:  BACKEND_URL + '/api/oauth/facebook/callback',
    scope:         'ads_read,ads_management,business_management',
    response_type: 'code',
    state,
  });
  res.redirect('https://www.facebook.com/v20.0/dialog/oauth?' + params);
});

// Discovery: connect without specific client
router.get('/facebook/connect-init', authQuery, (req, res) => {
  const state = encodeState({ mode: 'discover', userId: req.user.userId, ts: Date.now() });
  const params = new URLSearchParams({
    client_id:     process.env.FB_APP_ID,
    redirect_uri:  BACKEND_URL + '/api/oauth/facebook/callback',
    scope:         'ads_read,ads_management,business_management',
    response_type: 'code',
    state,
  });
  res.redirect('https://www.facebook.com/v20.0/dialog/oauth?' + params);
});

router.get('/facebook/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect(FRONTEND_URL + '/dashboard.html?oauth_error=facebook');

  try {
    const st = decodeState(state);

    const shortRes = await axios.get('https://graph.facebook.com/v20.0/oauth/access_token', {
      params: {
        client_id:     process.env.FB_APP_ID,
        client_secret: process.env.FB_APP_SECRET,
        redirect_uri:  BACKEND_URL + '/api/oauth/facebook/callback',
        code,
      },
    });
    const longRes = await axios.get('https://graph.facebook.com/v20.0/oauth/access_token', {
      params: {
        grant_type:        'fb_exchange_token',
        client_id:         process.env.FB_APP_ID,
        client_secret:     process.env.FB_APP_SECRET,
        fb_exchange_token: shortRes.data.access_token,
      },
    });

    const accessToken = longRes.data.access_token;
    const expiresIn   = longRes.data.expires_in || 5184000;
    const expiresAt   = new Date(Date.now() + expiresIn * 1000);

    if (st.mode === 'discover') {
      await saveUserToken(st.userId, 'facebook', accessToken, null, expiresAt);
      return res.redirect(FRONTEND_URL + '/dashboard.html?connected=facebook');
    }

    await saveClientToken(st.clientId, 'facebook', accessToken, null, expiresAt);
    res.redirect(FRONTEND_URL + '/dashboard.html?oauth_success=facebook');
  } catch(e) {
    console.error('[OAUTH FB]', e.message);
    res.redirect(FRONTEND_URL + '/dashboard.html?oauth_error=facebook');
  }
});

// ════════════════════ GOOGLE ════════════════════

router.get('/google/init', authQuery, (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).send('client_id required');
  const state = encodeState({ mode: 'client', clientId: client_id, userId: req.user.userId, ts: Date.now() });
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  BACKEND_URL + '/api/oauth/google/callback',
    scope:         'https://www.googleapis.com/auth/adwords',
    response_type: 'code',
    access_type:   'offline',
    prompt:        'consent',
    state,
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params);
});

router.get('/google/connect-init', authQuery, (req, res) => {
  const state = encodeState({ mode: 'discover', userId: req.user.userId, ts: Date.now() });
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  BACKEND_URL + '/api/oauth/google/callback',
    scope:         'https://www.googleapis.com/auth/adwords',
    response_type: 'code',
    access_type:   'offline',
    prompt:        'consent',
    state,
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params);
});

router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect(FRONTEND_URL + '/dashboard.html?oauth_error=google');

  try {
    const st = decodeState(state);
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  BACKEND_URL + '/api/oauth/google/callback',
      grant_type:    'authorization_code',
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);

    if (st.mode === 'discover') {
      await saveUserToken(st.userId, 'google', access_token, refresh_token, expiresAt);
      return res.redirect(FRONTEND_URL + '/dashboard.html?connected=google');
    }

    await saveClientToken(st.clientId, 'google', access_token, refresh_token, expiresAt);
    res.redirect(FRONTEND_URL + '/dashboard.html?oauth_success=google');
  } catch(e) {
    console.error('[OAUTH GOOGLE]', e.message);
    res.redirect(FRONTEND_URL + '/dashboard.html?oauth_error=google');
  }
});

// ════════════════════ TIKTOK ════════════════════

router.get('/tiktok/init', authQuery, (req, res) => {
  const { client_id } = req.query;
  if (!client_id) return res.status(400).send('client_id required');
  const state = encodeState({ mode: 'client', clientId: client_id, userId: req.user.userId, ts: Date.now() });
  const params = new URLSearchParams({
    app_id:       process.env.TT_APP_ID,
    redirect_uri: BACKEND_URL + '/api/oauth/tiktok/callback',
    state,
  });
  res.redirect('https://business-api.tiktok.com/portal/auth?' + params);
});

router.get('/tiktok/connect-init', authQuery, (req, res) => {
  const state = encodeState({ mode: 'discover', userId: req.user.userId, ts: Date.now() });
  const params = new URLSearchParams({
    app_id:       process.env.TT_APP_ID,
    redirect_uri: BACKEND_URL + '/api/oauth/tiktok/callback',
    state,
  });
  res.redirect('https://business-api.tiktok.com/portal/auth?' + params);
});

router.get('/tiktok/callback', async (req, res) => {
  const { auth_code, state, error } = req.query;
  if (error || !auth_code) return res.redirect(FRONTEND_URL + '/dashboard.html?oauth_error=tiktok');

  try {
    const st = decodeState(state);
    const tokenRes = await axios.post('https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/', {
      app_id:    process.env.TT_APP_ID,
      secret:    process.env.TT_APP_SECRET,
      auth_code,
    });
    if (tokenRes.data?.code !== 0) throw new Error(tokenRes.data?.message || 'TikTok OAuth failed');

    const data          = tokenRes.data.data || {};
    const access_token  = data.access_token;
    const refresh_token = data.refresh_token || null;
    const expiresAt     = new Date(Date.now() + (data.expires_in || 86400) * 1000);
    const advertiserIds = data.advertiser_ids || [];

    if (st.mode === 'discover') {
      await saveUserToken(st.userId, 'tiktok', access_token, refresh_token, expiresAt, { advertiser_ids: advertiserIds });
      return res.redirect(FRONTEND_URL + '/dashboard.html?connected=tiktok');
    }

    await saveClientToken(st.clientId, 'tiktok', access_token, refresh_token, expiresAt);
    if (advertiserIds.length) {
      await query(
        `UPDATE clients SET tt_account_id=$1 WHERE id=$2 AND (tt_account_id IS NULL OR tt_account_id='')`,
        [String(advertiserIds[0]), st.clientId]
      );
    }
    res.redirect(FRONTEND_URL + '/dashboard.html?oauth_success=tiktok');
  } catch(e) {
    console.error('[OAUTH TT]', e.message);
    res.redirect(FRONTEND_URL + '/dashboard.html?oauth_error=tiktok');
  }
});

// ════════════════════ AMOCRM ════════════════════

router.get('/amocrm/init', authQuery, (req, res) => {
  const { client_id, subdomain } = req.query;
  if (!client_id || !subdomain) return res.status(400).send('client_id and subdomain required');

  const state  = encodeState({ mode: 'client', clientId: client_id, subdomain, userId: req.user.userId, ts: Date.now() });
  const params = new URLSearchParams({
    client_id:     process.env.AMO_CLIENT_ID,
    redirect_uri:  BACKEND_URL + '/api/oauth/amocrm/callback',
    response_type: 'code',
    state,
    mode:          'popup',
  });
  res.redirect('https://' + subdomain + '.amocrm.ru/oauth?' + params);
});

router.get('/amocrm/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code) return res.redirect(FRONTEND_URL + '/dashboard.html?oauth_error=amocrm');

  try {
    const st = decodeState(state);
    const tokenRes = await axios.post('https://' + st.subdomain + '.amocrm.ru/oauth2/access_token', {
      client_id:     process.env.AMO_CLIENT_ID,
      client_secret: process.env.AMO_CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  BACKEND_URL + '/api/oauth/amocrm/callback',
    });
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const expiresAt = new Date(Date.now() + (expires_in || 86400) * 1000);

    await saveClientToken(st.clientId, 'amocrm', access_token, refresh_token, expiresAt);
    await query('UPDATE clients SET amo_subdomain=$1 WHERE id=$2', [st.subdomain, st.clientId]);
    res.redirect(FRONTEND_URL + '/dashboard.html?oauth_success=amocrm');
  } catch(e) {
    console.error('[OAUTH AMO]', e.message);
    res.redirect(FRONTEND_URL + '/dashboard.html?oauth_error=amocrm');
  }
});

module.exports = router;
