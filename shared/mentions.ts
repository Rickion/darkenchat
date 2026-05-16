// Sentinel clientId that means "@everyone in the room".
export const MENTION_ALL_ID = 'ALL'
// Sentinel clientId that means "@every AI in the room".
export const MENTION_ALL_AI_ID = 'ALL_AI'

// Plain-text aliases the sender may write to invoke @everyone. The first
// matching alias wins — its surface form is preserved in the rendered chip.
export const MENTION_ALL_ALIASES = ['All', '所有人']
export const MENTION_ALL_AI_ALIASES = ['AllAI', 'AllAIs', '所有AI', '所有 AI']
