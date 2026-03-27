<script setup lang="ts">
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { all, createLowlight } from 'lowlight'
import { useI18n } from 'vue-i18n'

const lowlight = createLowlight(all)

const { t } = useI18n()

const emit = defineEmits<{
  send: [html: string]
}>()

const props = defineProps<{
  disabled?: boolean
}>()

const editor = useEditor({
  extensions: [
    StarterKit.configure({ codeBlock: false, link: false as never, underline: false as never }),
    Underline,
    Link.configure({ openOnClick: false }),
    Image,
    Placeholder.configure({ placeholder: t('room.input_placeholder') }),
    CodeBlockLowlight.configure({ lowlight }),
  ],
  editorProps: {
    handleKeyDown(view, event) {
      if (props.disabled) return false
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        submit()
        return true
      }
      return false
    },
    handlePaste(view, event) {
      const items = Array.from(event.clipboardData?.items ?? [])
      const imgItem = items.find(i => i.type.startsWith('image/'))
      if (imgItem) {
        const file = imgItem.getAsFile()
        if (file && file.size <= 2 * 1024 * 1024) {
          const reader = new FileReader()
          reader.onload = (e) => {
            editor.value?.chain().focus().setImage({ src: e.target?.result as string }).run()
          }
          reader.readAsDataURL(file)
          return true
        }
      }
      return false
    },
  },
})

function submit() {
  if (!editor.value) return
  const html = editor.value.getHTML()
  if (html === '<p></p>' || !html.trim()) return
  emit('send', html)
  editor.value.commands.clearContent(true)
}

function toggleBold()         { editor.value?.chain().focus().toggleBold().run() }
function toggleItalic()       { editor.value?.chain().focus().toggleItalic().run() }
function toggleUnderline()    { editor.value?.chain().focus().toggleUnderline().run() }
function toggleStrike()       { editor.value?.chain().focus().toggleStrike().run() }
function toggleCode()         { editor.value?.chain().focus().toggleCode().run() }
function toggleCodeBlock()    { editor.value?.chain().focus().toggleCodeBlock().run() }
function toggleBulletList()   { editor.value?.chain().focus().toggleBulletList().run() }
function toggleOrderedList()  { editor.value?.chain().focus().toggleOrderedList().run() }
function toggleBlockquote()   { editor.value?.chain().focus().toggleBlockquote().run() }
function setLink() {
  const url = window.prompt('Enter URL')
  if (url) editor.value?.chain().focus().setLink({ href: url }).run()
}

function isActive(name: string, opts?: Record<string, unknown>) {
  return editor.value?.isActive(name, opts) ?? false
}
</script>

<template>
  <div class="rich-editor">
    <!-- Toolbar -->
    <div class="toolbar">
      <v-btn icon size="x-small" variant="text" :color="isActive('bold') ? 'primary' : ''" @click="toggleBold"><b>B</b></v-btn>
      <v-btn icon size="x-small" variant="text" :color="isActive('italic') ? 'primary' : ''" @click="toggleItalic"><i>I</i></v-btn>
      <v-btn icon size="x-small" variant="text" :color="isActive('underline') ? 'primary' : ''" @click="toggleUnderline"><u>U</u></v-btn>
      <v-btn icon size="x-small" variant="text" :color="isActive('strike') ? 'primary' : ''" @click="toggleStrike"><s>S</s></v-btn>
      <div class="sep" />
      <v-btn icon="mdi-code-tags" size="x-small" variant="text" :color="isActive('code') ? 'primary' : ''" @click="toggleCode" />
      <v-btn icon="mdi-code-block-tags" size="x-small" variant="text" :color="isActive('codeBlock') ? 'primary' : ''" @click="toggleCodeBlock" />
      <div class="sep" />
      <v-btn icon="mdi-link" size="x-small" variant="text" :color="isActive('link') ? 'primary' : ''" @click="setLink" />
      <v-btn icon="mdi-format-list-bulleted" size="x-small" variant="text" :color="isActive('bulletList') ? 'primary' : ''" @click="toggleBulletList" />
      <v-btn icon="mdi-format-list-numbered" size="x-small" variant="text" :color="isActive('orderedList') ? 'primary' : ''" @click="toggleOrderedList" />
      <v-btn icon="mdi-format-quote-close" size="x-small" variant="text" :color="isActive('blockquote') ? 'primary' : ''" @click="toggleBlockquote" />
    </div>

    <!-- Editor area -->
    <div class="editor-row">
      <div class="editor-wrap">
        <editor-content :editor="editor" />
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
.toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid #2a2a2a;
  flex-wrap: wrap;
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
  flex: 1;
  background: #1e1e1e;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid #333;
}
</style>
