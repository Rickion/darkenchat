<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import { Node, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { all, createLowlight } from 'lowlight'
import { useI18n } from 'vue-i18n'
import type { MemberInfo } from '@/types'
import { MENTION_ALL_ID, MENTION_ALL_AI_ID } from '@/_shared/mentions'

const lowlight = createLowlight(all)

const { t } = useI18n()

const emit = defineEmits<{
  send: [html: string]
}>()

const props = defineProps<{
  disabled?: boolean
  members?: MemberInfo[]
  clientId?: string
}>()

// ─── Mention inline node ─────────────────────────────────
// Atomic inline node so the chip is treated as a single character by the
// editor (selection, deletion, cursor movement) — exactly what users expect.
const Mention = Node.create({
  name: 'mention',
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      mentionId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-mention-id'),
        renderHTML: (a: Record<string, unknown>) => ({ 'data-mention-id': a.mentionId }),
      },
      label: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? el.textContent?.replace(/^@/, '') ?? '',
        renderHTML: (a: Record<string, unknown>) => ({ 'data-label': a.label }),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span.mention' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'mention' }, HTMLAttributes), `@${node.attrs.label}`]
  },
})

// ─── Mention picker state ────────────────────────────────
const mentionOpen = ref(false)
const mentionQuery = ref('')
const mentionFrom = ref(-1) // doc-position of the @ character
const mentionIndex = ref(0)
const mentionCoords = ref({ top: 0, left: 0 })
const editorWrap = ref<HTMLElement | null>(null)
const mentionMenuEl = ref<HTMLElement | null>(null)

const mentionCandidates = computed<MemberInfo[]>(() => {
  const allOption: MemberInfo = { clientId: MENTION_ALL_ID, nickname: t('room.mention_all'), joinedAt: 0 }
  // "@All AI" pseudo-member — only offered once the room has ≥2 AI members.
  const botCount = (props.members ?? []).filter(m => m.isBot).length
  const fixed: MemberInfo[] = [allOption]
  if (botCount >= 2) {
    fixed.push({ clientId: MENTION_ALL_AI_ID, nickname: t('room.mention_all_ai'), joinedAt: 0, isBot: true })
  }
  // Bots are addressable just like any other member — allow @-ing AIs so a
  // user can hand a question to a specific AI panellist. Order: humans first,
  // AIs last, so the list reads as @All → @AllAI → humans → AIs.
  const list = (props.members ?? []).filter(m => m.clientId !== props.clientId)
  const ordered = [...list.filter(m => !m.isBot), ...list.filter(m => m.isBot)]
  if (!mentionQuery.value) return [...fixed, ...ordered.slice(0, 8)]
  const q = mentionQuery.value.toLowerCase()
  return [...fixed, ...ordered.filter(m => m.nickname.toLowerCase().includes(q)).slice(0, 8)]
})

function closeMention() {
  mentionOpen.value = false
  mentionQuery.value = ''
  mentionFrom.value = -1
  mentionIndex.value = 0
}

function detectMention() {
  const ed = editor.value
  if (!ed) return
  const state = ed.state
  const sel = state.selection
  if (!sel.empty) {
    closeMention()
    return
  }
  const $pos = sel.$from
  const textBefore = $pos.parent.textBetween(0, $pos.parentOffset, '\n', '￼')
  // Trigger on `@` typed at ANY position — start of line, after whitespace, or
  // mid-word. The query is the run of non-whitespace chars up to the cursor.
  const m = textBefore.match(/@([^\s@]{0,24})$/)
  if (!m) {
    closeMention()
    return
  }

  mentionQuery.value = m[1]
  mentionFrom.value = sel.from - m[1].length - 1
  mentionIndex.value = 0
  mentionOpen.value = true

  // First pass uses estimated popup size; second pass measures the rendered menu.
  positionMentionMenu()
  nextTick(positionMentionMenu)
}

function positionMentionMenu() {
  const ed = editor.value
  if (!ed || mentionFrom.value < 0) return
  const wrapRect = editorWrap.value?.getBoundingClientRect()
  if (!wrapRect) return
  let coords: { top: number; bottom: number; left: number; right: number }
  try {
    coords = ed.view.coordsAtPos(mentionFrom.value)
  } catch {
    return
  }

  const margin = 8
  const menuEl = mentionMenuEl.value
  const popupWidth = menuEl?.offsetWidth ?? 200
  const popupHeight = menuEl?.offsetHeight ?? 230

  // Preferred placement: just below the @, left-aligned with it.
  let topV = coords.bottom + 4
  let leftV = coords.left

  // Clamp horizontally inside the viewport.
  if (leftV + popupWidth > window.innerWidth - margin) {
    leftV = window.innerWidth - margin - popupWidth
  }
  if (leftV < margin) leftV = margin

  // If it would overflow the bottom, flip above the caret; otherwise pin.
  if (topV + popupHeight > window.innerHeight - margin) {
    const above = coords.top - popupHeight - 4
    topV = above >= margin ? above : Math.max(margin, window.innerHeight - margin - popupHeight)
  }
  if (topV < margin) topV = margin

  mentionCoords.value = {
    top: topV - wrapRect.top,
    left: leftV - wrapRect.left,
  }
}

function acceptMention(member: MemberInfo) {
  const ed = editor.value
  if (!ed || mentionFrom.value < 0) return
  const to = ed.state.selection.from
  ed.chain()
    .focus()
    .deleteRange({ from: mentionFrom.value, to })
    .insertContent([
      { type: 'mention', attrs: { mentionId: member.clientId, label: member.nickname } },
      { type: 'text', text: ' ' },
    ])
    .run()
  closeMention()
}

const editor = useEditor({
  extensions: [
    StarterKit.configure({ codeBlock: false, link: false as never, underline: false as never }),
    Underline,
    Link.configure({ openOnClick: false }),
    Image,
    Placeholder.configure({ placeholder: t('room.input_placeholder') }),
    CodeBlockLowlight.configure({ lowlight }),
    Mention,
  ],
  editorProps: {
    handleKeyDown(_view, event) {
      if (props.disabled) return false

      // Mention menu navigation has priority over normal handlers
      if (mentionOpen.value && mentionCandidates.value.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          mentionIndex.value = (mentionIndex.value + 1) % mentionCandidates.value.length
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          mentionIndex.value =
            (mentionIndex.value - 1 + mentionCandidates.value.length) % mentionCandidates.value.length
          return true
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          acceptMention(mentionCandidates.value[mentionIndex.value])
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          closeMention()
          return true
        }
      }

      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submit()
        return true
      }
      return false
    },
    handlePaste(_view, event) {
      const items = Array.from(event.clipboardData?.items ?? [])
      const imgItem = items.find(i => i.type.startsWith('image/'))
      if (imgItem) {
        const file = imgItem.getAsFile()
        if (file && file.size <= 2 * 1024 * 1024) {
          const reader = new FileReader()
          reader.onload = e => {
            editor.value
              ?.chain()
              .focus()
              .setImage({ src: e.target?.result as string })
              .run()
          }
          reader.readAsDataURL(file)
          return true
        }
      }
      return false
    },
  },
  onUpdate() {
    nextTick(detectMention)
  },
  onSelectionUpdate() {
    nextTick(detectMention)
  },
})

function submit() {
  if (!editor.value) return
  const html = editor.value.getHTML()
  if (html === '<p></p>' || !html.trim()) return
  emit('send', html)
  editor.value.commands.clearContent(true)
  closeMention()
}

function toggleBold() {
  editor.value?.chain().focus().toggleBold().run()
}
function toggleItalic() {
  editor.value?.chain().focus().toggleItalic().run()
}
function toggleUnderline() {
  editor.value?.chain().focus().toggleUnderline().run()
}
function toggleStrike() {
  editor.value?.chain().focus().toggleStrike().run()
}
function toggleCode() {
  editor.value?.chain().focus().toggleCode().run()
}
function toggleCodeBlock() {
  editor.value?.chain().focus().toggleCodeBlock().run()
}
function toggleBulletList() {
  editor.value?.chain().focus().toggleBulletList().run()
}
function toggleOrderedList() {
  editor.value?.chain().focus().toggleOrderedList().run()
}
function toggleBlockquote() {
  editor.value?.chain().focus().toggleBlockquote().run()
}
function setLink() {
  const url = window.prompt(t('room.input_url_prompt'))
  if (url) editor.value?.chain().focus().setLink({ href: url }).run()
}

function isActive(name: string, opts?: Record<string, unknown>) {
  return editor.value?.isActive(name, opts) ?? false
}

// ─── Responsive toolbar collapse ─────────────────────────
const combinedBar = ref<HTMLElement | null>(null)
const toolbarCollapsed = ref(false)
let ro: ResizeObserver | null = null

const TOOLBAR_MIN_WIDTH = 360

function recompute() {
  const root = combinedBar.value
  if (!root) return
  const actionBar = root.querySelector<HTMLElement>('.action-bar')
  const actionWidth = actionBar?.offsetWidth ?? 0
  const available = root.clientWidth - actionWidth - 16
  toolbarCollapsed.value = available < TOOLBAR_MIN_WIDTH
}

onMounted(() => {
  if (combinedBar.value) {
    ro = new ResizeObserver(() => recompute())
    ro.observe(combinedBar.value)
    recompute()
  }
})

onUnmounted(() => {
  ro?.disconnect()
  ro = null
})
</script>

<template>
  <div class="rich-editor">
    <!-- Combined bar: action-bar (left, fixed) + toolbar (right, collapsible) -->
    <div ref="combinedBar" class="combined-bar">
      <div class="action-bar">
        <slot name="action-bar" />
      </div>

      <!-- Expanded toolbar -->
      <div v-if="!toolbarCollapsed" class="toolbar">
        <v-btn icon size="x-small" variant="text" :color="isActive('bold') ? 'primary' : ''" @click="toggleBold">
          <b>B</b>
        </v-btn>
        <v-btn icon size="x-small" variant="text" :color="isActive('italic') ? 'primary' : ''" @click="toggleItalic">
          <i>I</i>
        </v-btn>
        <v-btn
          icon
          size="x-small"
          variant="text"
          :color="isActive('underline') ? 'primary' : ''"
          @click="toggleUnderline">
          <u>U</u>
        </v-btn>
        <v-btn icon size="x-small" variant="text" :color="isActive('strike') ? 'primary' : ''" @click="toggleStrike">
          <s>S</s>
        </v-btn>
        <div class="sep" />
        <v-btn
          icon="mdi-code-tags"
          size="x-small"
          variant="text"
          :color="isActive('code') ? 'primary' : ''"
          @click="toggleCode" />
        <v-btn
          icon="mdi-code-braces"
          size="x-small"
          variant="text"
          :color="isActive('codeBlock') ? 'primary' : ''"
          @click="toggleCodeBlock" />
        <div class="sep" />
        <v-btn
          icon="mdi-link"
          size="x-small"
          variant="text"
          :color="isActive('link') ? 'primary' : ''"
          @click="setLink" />
        <v-btn
          icon="mdi-format-list-bulleted"
          size="x-small"
          variant="text"
          :color="isActive('bulletList') ? 'primary' : ''"
          @click="toggleBulletList" />
        <v-btn
          icon="mdi-format-list-numbered"
          size="x-small"
          variant="text"
          :color="isActive('orderedList') ? 'primary' : ''"
          @click="toggleOrderedList" />
        <v-btn
          icon="mdi-format-quote-close"
          size="x-small"
          variant="text"
          :color="isActive('blockquote') ? 'primary' : ''"
          @click="toggleBlockquote" />
      </div>

      <!-- Collapsed: overflow "…" menu -->
      <v-menu v-else location="top end" :close-on-content-click="false">
        <template #activator="{ props: ap }">
          <v-btn icon="mdi-dots-horizontal" size="x-small" variant="text" class="overflow-btn" v-bind="ap" />
        </template>
        <div class="toolbar overflow-menu">
          <v-btn icon size="x-small" variant="text" :color="isActive('bold') ? 'primary' : ''" @click="toggleBold">
            <b>B</b>
          </v-btn>
          <v-btn icon size="x-small" variant="text" :color="isActive('italic') ? 'primary' : ''" @click="toggleItalic">
            <i>I</i>
          </v-btn>
          <v-btn
            icon
            size="x-small"
            variant="text"
            :color="isActive('underline') ? 'primary' : ''"
            @click="toggleUnderline">
            <u>U</u>
          </v-btn>
          <v-btn icon size="x-small" variant="text" :color="isActive('strike') ? 'primary' : ''" @click="toggleStrike">
            <s>S</s>
          </v-btn>
          <div class="sep" />
          <v-btn
            icon="mdi-code-tags"
            size="x-small"
            variant="text"
            :color="isActive('code') ? 'primary' : ''"
            @click="toggleCode" />
          <v-btn
            icon="mdi-code-braces"
            size="x-small"
            variant="text"
            :color="isActive('codeBlock') ? 'primary' : ''"
            @click="toggleCodeBlock" />
          <div class="sep" />
          <v-btn
            icon="mdi-link"
            size="x-small"
            variant="text"
            :color="isActive('link') ? 'primary' : ''"
            @click="setLink" />
          <v-btn
            icon="mdi-format-list-bulleted"
            size="x-small"
            variant="text"
            :color="isActive('bulletList') ? 'primary' : ''"
            @click="toggleBulletList" />
          <v-btn
            icon="mdi-format-list-numbered"
            size="x-small"
            variant="text"
            :color="isActive('orderedList') ? 'primary' : ''"
            @click="toggleOrderedList" />
          <v-btn
            icon="mdi-format-quote-close"
            size="x-small"
            variant="text"
            :color="isActive('blockquote') ? 'primary' : ''"
            @click="toggleBlockquote" />
        </div>
      </v-menu>
    </div>

    <!-- Editor area -->
    <div class="editor-row">
      <div ref="editorWrap" class="editor-wrap">
        <editor-content :editor="editor" />

        <!-- Mention picker -->
        <div
          v-if="mentionOpen && mentionCandidates.length > 0"
          ref="mentionMenuEl"
          class="mention-menu"
          :style="{ top: mentionCoords.top + 'px', left: mentionCoords.left + 'px' }"
          @mousedown.prevent>
          <div
            v-for="(m, i) in mentionCandidates"
            :key="m.clientId"
            class="mention-item"
            :class="{ active: i === mentionIndex }"
            @click="acceptMention(m)"
            @mouseenter="mentionIndex = i">
            <v-icon size="13" :color="m.isBot ? 'secondary' : 'primary'">{{ m.isBot ? 'mdi-robot' : 'mdi-at' }}</v-icon>
            <!-- Explicit "AI" tag so it's unmistakable this entry is a bot -->
            <span v-if="m.isBot" class="ai-tag">AI</span>
            <span>{{ m.nickname }}</span>
          </div>
        </div>
      </div>
      <v-btn icon="mdi-send" color="primary" size="small" :disabled="props.disabled" @click="submit" />
    </div>
  </div>
</template>

<style scoped>
.rich-editor {
  border-top: 1px solid #2e2e2e;
  background: var(--dc-panel);
}
.combined-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px;
  border-bottom: 1px solid #2a2a2a;
  min-width: 0;
}
.action-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  flex-wrap: nowrap;
  overflow: hidden;
  min-width: 0;
}
.overflow-btn {
  margin-left: auto;
}
.overflow-menu {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  max-width: 280px;
  padding: 6px 8px;
  background: var(--dc-panel);
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
}
.sep {
  width: 1px;
  height: 16px;
  background: #3a3a3a;
  margin: 0 4px;
}
.editor-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 6px 8px;
}
.editor-wrap {
  position: relative;
  flex: 1;
  background: #1e1e1e;
  border-radius: 10px;
  overflow: visible;
  border: 1px solid #333;
}
.editor-wrap :deep(.tiptap) {
  border-radius: 10px;
}

/* Mention picker popup */
.mention-menu {
  position: absolute;
  z-index: 200;
  min-width: 160px;
  max-height: 220px;
  overflow-y: auto;
  background: #2a2a2a;
  border: 1px solid #3a3a3a;
  border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  padding: 5px;
}
.mention-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.88rem;
  color: var(--dc-text);
  user-select: none;
}
.mention-item.active,
.mention-item:hover {
  background: rgba(201, 168, 76, 0.18);
}
.mention-item.active {
  color: var(--dc-gold);
}
/* "AI" tag prefixed to bot entries in the mention picker */
.ai-tag {
  flex-shrink: 0;
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  background: rgba(124, 179, 255, 0.18);
  color: var(--dc-blue, #7cb3ff);
}
@media (max-width: 480px) {
  .combined-bar {
    padding: 2px 4px;
    gap: 4px;
  }
  .editor-row {
    padding: 6px 4px;
    gap: 4px;
  }
}
</style>
