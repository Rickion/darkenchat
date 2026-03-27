/**
 * Calculate local device score for center-node election.
 * Higher score = better candidate for center node.
 *
 * The most important factor is whether this node can reach others via STUN
 * (i.e. is NOT behind CGNAT/symmetric NAT). Nodes in WS relay mode are poor
 * center candidates because every other member would have to relay through
 * the signaling server if they become center.
 *
 * Score layers (highest → lowest priority):
 *   1. Connection type  +300 p2p / +150 turn / -100 relay
 *   2. Device stability +100 desktop Chrome visible / … / 5 iOS hidden
 *   3. Join order       +0–10 (earlier = slightly better)
 */
export function calcDeviceScore(joinOrder: number, connState?: string): number {
  const ua = navigator.userAgent
  const isVisible = !document.hidden

  const isMobile = /Mobi|Android|iPhone|iPad/i.test(ua)
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua)
  const isIOS    = /iPad|iPhone|iPod/.test(ua)

  let base: number
  if (!isMobile && !isSafari)           base = isVisible ? 100 : 60
  else if (!isMobile && isSafari)       base = isVisible ? 70  : 30
  else if (isMobile && !isSafari && !isIOS) base = isVisible ? 50 : 20
  else if (isIOS)                       base = isVisible ? 15  : 5
  else                                  base = isVisible ? 50  : 20

  // Connection type bonus — dominates over device score.
  // p2p: we punched through NAT, good hub candidate.
  // turn: TURN relay, still connectable end-to-end encrypted.
  // relay: behind CGNAT or symmetric NAT, very bad hub candidate.
  const connBonus =
    connState === 'p2p'   ?  300 :
    connState === 'turn'  ?  150 :
    connState === 'relay' ? -100 :
    0  // 'connecting' / unknown: neutral

  return connBonus + base + Math.max(10 - joinOrder, 0)
}
