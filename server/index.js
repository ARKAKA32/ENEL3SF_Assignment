require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { randomUUID } = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { classifyIncident, SEVERITIES } = require('./classify');
const { reportInput, validateFiles, validateUpdate, badRequest, UUID, MAX_FILE_SIZE, MAX_FILES } = require('./validation');
const { createPush, validSubscription } = require('./push');
const BUCKET = 'incident-media';
const isStaff = (profile) => ['operator', 'responder', 'admin'].includes(profile?.role);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES, fields: 12, fieldSize: 10000 } }).array('media', MAX_FILES);
const options = { auth: { persistSession: false, autoRefreshToken: false } };
function createApp({ db, userClient, classify = classifyIncident, push } = {}) {
  const configured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_ANON_KEY);
  db ||= configured ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, options) : null;
  userClient ||= (token) => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { ...options, global: { headers: { Authorization: `Bearer ${token}` } } });
  push ||= createPush(db);
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY));
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/vendor/supabase.js', (req, res) => res.sendFile(path.join(path.dirname(require.resolve('@supabase/supabase-js')), 'umd', 'supabase.js')));
  app.get('/api/health', (req, res) => res.json({ ok: Boolean(db), ai: Boolean(process.env.ANTHROPIC_API_KEY), supabase: Boolean(db), push: push.enabled }));
  app.get('/api/push/config', (req, res) => res.json({ enabled: push.enabled, public_key: push.enabled ? process.env.VAPID_PUBLIC_KEY : null }));
  app.use('/api', (req, res, next) => db ? next() : res.status(503).json({ error: 'Server setup is incomplete. Configure the Supabase environment variables.' }));
  const writeLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many submissions. Please wait before trying again.' } });
  async function identity(req, res, next) {
    try {
      const header = req.get('Authorization');
      if (!header) return next();
      if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Invalid authentication.' });
      req.token = header.slice(7);
      const { data, error } = await db.auth.getUser(req.token);
      if (error || !data.user) return res.status(401).json({ error: 'Your session expired. Log in again.' });
      const profile = await db.from('users').select('*').eq('user_id', data.user.id).single();
      if (profile.error || profile.data?.account_status !== 'active') return res.status(403).json({ error: 'This account is unavailable.' });
      req.profile = profile.data;
      next();
    } catch (error) { next(error); }
  }
  const requireUser = (req, res, next) => req.profile ? next() : res.status(401).json({ error: 'Please log in.' });
  async function incidentAccess(req, res, next) {
    if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'Invalid incident reference.' });
    try {
      const { data, error } = await db.from('incidents').select('*').eq('incident_id', req.params.id).single();
      if (error || !data || (!isStaff(req.profile) && (data.is_anon || data.reporter_id !== req.profile.user_id))) return res.status(404).json({ error: 'Incident not found.' });
      req.incident = data;
      next();
    } catch (error) { next(error); }
  }
  async function attachMedia(id, files) {
    const warnings = [];
    for (const file of files || []) {
      const objectPath = `${id}/${randomUUID()}.${file.mimetype === 'image/png' ? 'png' : 'jpg'}`;
      const stored = await db.storage.from(BUCKET).upload(objectPath, file.buffer, { contentType: file.mimetype, upsert: false });
      if (stored.error) { warnings.push('An image could not be uploaded.'); continue; }
      const linked = await db.from('incident_media').insert({ incident_id: id, file_url: objectPath, file_type: 'image', file_size: file.size });
      if (linked.error) {
        await db.storage.from(BUCKET).remove([objectPath]);
        warnings.push('An image could not be linked to the report.');
      }
    }
    return warnings;
  }
  app.post('/api/incidents', writeLimit, identity, upload, async (req, res, next) => {
    try {
      const input = reportInput(req.body, req.profile?.user_id);
      validateFiles(req.files);
      const result = await classify(input.description);
      const id = randomUUID();
      const inserted = await db.from('incidents').insert({ ...input, incident_id: id, status: 'new', category: result.category, severity: result.severity, title: result.title });
      if (inserted.error) throw inserted.error;
      let warnings;
      try { warnings = await attachMedia(id, req.files); }
      catch { warnings = ['Images could not be uploaded. Your report is saved.']; }
      if (result.ai_notes) {
        try {
          const logged = await db.from('incident_updates').insert({ incident_id: id, update_type: 'NOTE', note: result.ai_notes, is_public: false });
          if (logged.error) console.error('Classification note could not be saved.');
        } catch { console.error('Classification note could not be saved.'); }
      }
      res.status(201).json({ incident_id: id, warnings });
    } catch (error) { next(error); }
  });
  app.get('/api/incidents/:id/media', identity, requireUser, incidentAccess, async (req, res, next) => {
    try {
      const { data, error } = await db.from('incident_media').select('*').eq('incident_id', req.params.id).order('uploaded_at');
      if (error) throw error;
      const media = await Promise.all(data.map(async (item) => {
        if (!item.file_url.startsWith(`${req.params.id}/`) || item.file_url.includes('..')) return { media_id: item.media_id, url: null };
        const signed = await db.storage.from(BUCKET).createSignedUrl(item.file_url, 600);
        return { media_id: item.media_id, url: signed.data?.signedUrl || null };
      }));
      res.json(media);
    } catch (error) { next(error); }
  });
  app.post('/api/incidents/:id/media', writeLimit, identity, requireUser, incidentAccess, upload, async (req, res, next) => {
    try {
      validateFiles(req.files);
      if (!req.files?.length) throw badRequest('Select an image to upload.');
      res.json({ warnings: await attachMedia(req.params.id, req.files) });
    } catch (error) { next(error); }
  });
  app.patch('/api/incidents/:id', writeLimit, identity, requireUser, incidentAccess, async (req, res, next) => {
    if (!isStaff(req.profile)) return res.status(403).json({ error: 'Staff access required.' });
    try {
      validateUpdate(req.body);
      const { data: rpcData, error } = await userClient(req.token).rpc('save_incident_update', {
        p_id: req.params.id, p_status: req.body.status, p_category: req.body.category,
        p_severity: req.body.severity, p_assigned_to: req.body.assigned_to,
        p_note: req.body.note.trim(), p_is_public: req.body.is_public, p_expected_updated_at: req.body.expected_updated_at,
      });
      if (error) {
        const status = error.code === '40001' ? 409 : error.code === '42501' ? 403 : error.code === '22023' ? 400 : 500;
        return res.status(status).json({ error: status === 500 ? 'Could not save the incident.' : error.message });
      }
      const data = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      let delivery = {};
      if (!data.is_anon && data.reporter_id && (data.status !== req.incident.status || data.category !== req.incident.category || data.severity !== req.incident.severity || (req.body.is_public && req.body.note.trim()))) {
        // No incident description, location, or staff notes on a device's lock screen.
        delivery = await push.send({ title: 'Sentry report update', body: 'There is an update to your report. Log in to view it.', url: '/', tag: `incident-${req.params.id}` }, data.reporter_id);
      }
      res.json({ incident: data, ...delivery });
    } catch (error) { next(error); }
  });
  app.post('/api/broadcasts', writeLimit, identity, requireUser, async (req, res, next) => {
    if (!['admin', 'operator'].includes(req.profile.role)) return res.status(403).json({ error: 'Operator or admin access required.' });
    try {
      const title = String(req.body.title || '').trim(), message = String(req.body.message || '').trim();
      const hours = Number(req.body.hours);
      if (!title || title.length > 100 || !message || message.length > 2000 || !SEVERITIES.includes(req.body.severity) || !Number.isFinite(hours) || hours < 1 || hours > 168) throw badRequest('Provide a title, message, severity and expiry between 1 and 168 hours.');
      const { data, error } = await db.from('notifications').insert({ title, message, severity: req.body.severity, notification_type: 'PUBLIC_BROADCAST', created_by: req.profile.user_id, expires_at: new Date(Date.now() + hours * 3600000).toISOString() }).select('notification_id').single();
      if (error) throw error;
      const delivery = await push.send({ title: `Sentry: ${title}`, body: message.slice(0, 200), url: '/', tag: `broadcast-${data.notification_id}` }, null, Math.floor(hours * 3600));
      res.status(201).json({ ok: true, ...delivery });
    } catch (error) { next(error); }
  });
  app.post('/api/push/subscriptions', writeLimit, identity, requireUser, async (req, res, next) => {
    try {
      if (!push.enabled) return res.status(503).json({ error: 'Push notifications have not been configured on the server.' });
      if (!validSubscription(req.body)) throw badRequest('Unsupported push subscription. Try Chrome, Edge, Firefox or Safari.');
      const { error } = await db.from('push_subscriptions').upsert({ user_id: req.profile.user_id, endpoint: req.body.endpoint, keys: req.body.keys }, { onConflict: 'endpoint' });
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.delete('/api/push/subscriptions', identity, requireUser, async (req, res, next) => {
    try {
      const { error } = await db.from('push_subscriptions').delete().eq('endpoint', String(req.body.endpoint || '')).eq('user_id', req.profile.user_id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (error) { next(error); }
  });
  app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ error: 'Attach up to five PNG/JPEG images, each no larger than 5 MB.' });
    const status = error.status || 500;
    if (status >= 500) console.error('Request failed:', error.message);
    res.status(status).json({ error: status >= 500 ? 'The request could not be completed. Please try again.' : error.message });
  });
  return app;
}
if (require.main === module) createApp().listen(process.env.PORT || 3000, () => console.log(`Sentry running at http://localhost:${process.env.PORT || 3000}`));
module.exports = { createApp };
