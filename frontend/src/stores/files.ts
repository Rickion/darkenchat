import { defineStore } from 'pinia'
import { reactive } from 'vue'

export type FileStatus = 'idle' | 'downloading' | 'done' | 'error'

export interface IncomingFileState {
  name: string
  mime: string
  total: number       // total bytes
  received: number    // bytes received so far
  chunks: ArrayBuffer[]
  ownerId: string
}

// Module-scoped, NON-reactive map for outgoing File objects.
// File objects must not be wrapped by Vue reactivity (proxies break .arrayBuffer etc).
const outgoing = new Map<string, File>()

export const useFilesStore = defineStore('files', () => {
  // Reactive progress state for files I'm currently downloading.
  const incoming = reactive(new Map<string, IncomingFileState>())
  // Per-fileId status; surfaced to UI so MessageItem can show progress / state.
  const status   = reactive(new Map<string, FileStatus>())

  function setOutgoing(fileId: string, file: File) {
    outgoing.set(fileId, file)
  }

  function getOutgoing(fileId: string): File | undefined {
    return outgoing.get(fileId)
  }

  function startIncoming(fileId: string, total: number, name: string, mime: string, ownerId: string) {
    incoming.set(fileId, { name, mime, total, received: 0, chunks: [], ownerId })
    status.set(fileId, 'downloading')
  }

  function appendIncoming(fileId: string, chunk: ArrayBuffer) {
    const inc = incoming.get(fileId)
    if (!inc) return
    inc.chunks.push(chunk)
    inc.received += chunk.byteLength
  }

  function completeIncoming(fileId: string): { blob: Blob, name: string } | null {
    const inc = incoming.get(fileId)
    if (!inc) return null
    const blob = new Blob(inc.chunks, { type: inc.mime })
    const name = inc.name
    incoming.delete(fileId)
    status.set(fileId, 'done')
    return { blob, name }
  }

  function failIncoming(fileId: string) {
    incoming.delete(fileId)
    status.set(fileId, 'error')
  }

  function setStatus(fileId: string, s: FileStatus) {
    status.set(fileId, s)
  }

  function clearAll() {
    outgoing.clear()
    incoming.clear()
    status.clear()
  }

  return {
    incoming, status,
    setOutgoing, getOutgoing,
    startIncoming, appendIncoming, completeIncoming, failIncoming,
    setStatus, clearAll,
  }
})
