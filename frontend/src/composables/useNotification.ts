import { ref, onUnmounted } from 'vue'
import { useDocumentVisibility } from '@vueuse/core'

export function useNotification() {
  const unread = ref(0)
  const originalTitle = document.title
  const visibility = useDocumentVisibility()

  async function requestPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission()
    }
  }

  function notify(from: string, plainText: string) {
    if (visibility.value === 'visible') return

    // Tab title badge
    unread.value++
    document.title = `(${unread.value}) DarkenChat`

    // Browser notification
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`DarkenChat — ${from}`, {
        body: plainText.slice(0, 60),
        icon: '/favicon.ico',
      })
      n.onclick = () => { window.focus(); n.close() }
    }
  }

  function clearUnread() {
    unread.value = 0
    document.title = originalTitle
  }

  // Auto-clear when tab becomes visible
  const stop = watch(visibility, (v) => {
    if (v === 'visible') clearUnread()
  })
  onUnmounted(stop)

  return { unread, requestPermission, notify, clearUnread }
}

// ── tiny local import for watch ──
import { watch } from 'vue'
