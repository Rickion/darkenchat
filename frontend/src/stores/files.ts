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

// Module-scoped, NON-reactive map tracking what to do when a download
// completes: 'save' triggers a browser download, 'display' exposes a blob URL
// for inline rendering / playback (or for a generic file held ready to save).
const fetchModes = new Map<string, 'save' | 'display'>()

export const useFilesStore = defineStore('files', () => {
  // Reactive progress state for files I'm currently downloading.
  const incoming = reactive(new Map<string, IncomingFileState>())
  // Per-fileId status; surfaced to UI so MessageItem can show progress / state.
  const status   = reactive(new Map<string, FileStatus>())
  // blob: object URLs for fetched files — inline media (image/audio/video) or a
  // generic file fetched into memory and ready to save without a re-request.
  const objectUrls = reactive(new Map<string, string>())

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

  function setFetchMode(fileId: string, mode: 'save' | 'display') {
    fetchModes.set(fileId, mode)
  }

  function getFetchMode(fileId: string): 'save' | 'display' {
    return fetchModes.get(fileId) ?? 'save'
  }

  // Expose a fetched blob as an object URL (for inline display / playback or a
  // ready-to-save generic file). Revokes any previous URL for the same fileId.
  function setObjectUrl(fileId: string, url: string) {
    const prev = objectUrls.get(fileId)
    if (prev && prev !== url) URL.revokeObjectURL(prev)
    objectUrls.set(fileId, url)
    status.set(fileId, 'done')
  }

  function clearAll() {
    outgoing.clear()
    incoming.clear()
    status.clear()
    fetchModes.clear()
    for (const url of objectUrls.values()) URL.revokeObjectURL(url)
    objectUrls.clear()
  }

  return {
    incoming, status, objectUrls,
    setOutgoing, getOutgoing,
    startIncoming, appendIncoming, completeIncoming, failIncoming,
    setStatus, setFetchMode, getFetchMode, setObjectUrl, clearAll,
  }
})
