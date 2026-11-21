/* Support PWA service worker: shows push notifications and focuses the app. */
self.addEventListener('push', (event) => {
  let data = { publicId: '', kind: '', subject: '' }
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // Malformed payload still deserves a generic notification.
  }
  const title = data.kind === 'ticket.created' ? 'Новий тикет підтримки' : 'Нова відповідь клієнта'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.subject || 'Відкрийте додаток, щоб переглянути.',
      tag: data.publicId || 'support',
      renotify: true,
      data,
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.publicId
    ? `/staff?ticket=${encodeURIComponent(event.notification.data.publicId)}`
    : '/staff'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    }),
  )
})
