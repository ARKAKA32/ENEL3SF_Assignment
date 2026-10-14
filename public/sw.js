self.addEventListener('push', (event) => {
  let payload = { title: 'Sentry update', body: 'Open Sentry to view the latest update.' };
  try { if (event.data) payload = { ...payload, ...event.data.json() }; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, { body: payload.body, tag: payload.tag || 'sentry-update', data: { url: '/' } }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) if (new URL(client.url).origin === self.location.origin) { await client.navigate('/'); return client.focus(); }
    return self.clients.openWindow('/');
  })());
});
// No caching of reports, media, tokens or authenticated API responses.
