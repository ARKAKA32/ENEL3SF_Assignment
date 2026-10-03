const webPush = require('web-push');
function validSubscription(value) {
  try {
    const url = new URL(value.endpoint);
    const host = url.hostname;
    const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host === 'web.push.apple.com' || host.endsWith('.notify.windows.com');
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && allowed && value.endpoint.length < 2048 && /^[A-Za-z0-9_-]{87}$/.test(value.keys?.p256dh || '') && /^[A-Za-z0-9_-]{22}$/.test(value.keys?.auth || '');
  } catch { return false; }
}
function createPush(db, transport = webPush) {
  const enabled = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
  if (enabled) transport.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  async function send(payload, userId = null, ttl = 3600) {
    if (!enabled) return { warning: 'Push is not configured; the update is saved in the app.' };
    try {
      let query = db.from('push_subscriptions').select('*');
      if (userId) query = query.eq('user_id', userId);
      const { data, error } = await query;
      if (error) throw error;
      let failed = 0;
      // Limit concurrent network calls and skip inactive accounts.
      for (let offset = 0; offset < data.length; offset += 10) {
        await Promise.all(data.slice(offset, offset + 10).map(async (row) => {
          const profile = await db.from('users').select('account_status').eq('user_id', row.user_id).single();
          if (profile.data?.account_status !== 'active') return;
          try {
            await transport.sendNotification({ endpoint: row.endpoint, keys: row.keys }, JSON.stringify(payload), { TTL: ttl, timeout: 10000 });
          } catch (error) {
            if ([404, 410].includes(error.statusCode)) await db.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
            else failed++;
          }
        }));
      }
      return failed ? { warning: 'Saved, but some push notifications could not be delivered.' } : {};
    } catch { return { warning: 'Saved, but push delivery failed.' }; }
  }
  return { enabled, send };
}
module.exports = { createPush, validSubscription };
