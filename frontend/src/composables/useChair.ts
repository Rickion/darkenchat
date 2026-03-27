import { useRoomStore } from '@/stores/room'
import type { C2S } from '@/types'

/**
 * Chair-only actions. The signaling send function is injected
 * to keep this composable decoupled from useRoom.
 */
export function useChair(send: (msg: C2S) => void) {
  const roomStore = useRoomStore()

  function kick(targetId: string) {
    if (!roomStore.isChair) return
    send({ type: 'kick' as never, roomKey: roomStore.key, targetId } as never)
  }

  function endRoom() {
    if (!roomStore.isChair) return
    send({ type: 'end_room' as never, roomKey: roomStore.key } as never)
  }

  return { kick, endRoom }
}
