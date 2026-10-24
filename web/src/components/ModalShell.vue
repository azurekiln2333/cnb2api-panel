<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { X } from '@lucide/vue'
defineProps<{ title: string; subtitle?: string; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>()
let previousFocus: HTMLElement | null = null
onMounted(() => {
  previousFocus = document.activeElement as HTMLElement
  dialog.value?.showModal()
  document.body.style.overflow = 'hidden'
})
onBeforeUnmount(() => {
  dialog.value?.close()
  document.body.style.overflow = ''
  previousFocus?.focus()
})
</script>

<template>
  <dialog
    ref="dialog"
    class="modal"
    :class="{ wide }"
    aria-labelledby="modal-title"
    @cancel.prevent="emit('close')"
    @click="
      (event) => {
        if (event.target === dialog) emit('close')
      }
    "
  >
    <div class="modal-content">
      <header class="modal-header">
        <div>
          <h2 id="modal-title">{{ title }}</h2>
          <p v-if="subtitle">{{ subtitle }}</p>
        </div>
        <button class="icon-button" aria-label="关闭弹窗" @click="emit('close')">
          <X :size="19" />
        </button>
      </header>
      <slot />
    </div>
  </dialog>
</template>
