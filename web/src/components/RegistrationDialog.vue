<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Check, Copy, Terminal, ArrowUpRight } from '@lucide/vue'
import { api } from '../api'
import { copy } from '../console'
import type { Account } from '../types'
import ModalShell from './ModalShell.vue'
const props = defineProps<{ account: Account; token: string }>()
const emit = defineEmits<{ close: [] }>()
const baseUrl = ref(location.origin)
onMounted(async () => {
  try {
    const data = await api<{ publicUrl: string }>('/access')
    baseUrl.value = data.publicUrl || location.origin
  } catch {
    /* use current origin */
  }
})
const snippet = computed(
  () =>
    `env:\n  PROXY_KEY: "<该工作区的 PROXY_KEY>"\n  REGISTER_URL: ${JSON.stringify(`${baseUrl.value}/ops/register/${props.account.id}`)}\n  REG_TOKEN: ${JSON.stringify(props.token)}`,
)
</script>

<template>
  <ModalShell
    title="配置工作区自注册"
    :subtitle="[account.name, account.repo].filter(Boolean).join(' · ')"
    wide
    @close="emit('close')"
    ><div class="modal-body registration-body">
      <div class="success-callout">
        <span><Check :size="19" /></span>
        <div>
          <strong>工作区注册配置已就绪</strong>
          <p>仅在当前弹窗展示一次，请保存后再关闭。</p>
        </div>
      </div>
      <div class="step-label">
        <b>01</b>
        <div>
          <strong>把配置写入该账号的 CNB 私有仓库</strong>
          <p>在 .cnb.yml 的 vscode 阶段合并以下 env 字段，替换工作区 Key。</p>
        </div>
      </div>
      <div class="code-block">
        <div class="code-header">
          <span><Terminal :size="14" />.cnb.yml · vscode env</span
          ><button class="icon-button" aria-label="复制工作区配置" @click="copy(snippet)">
            <Copy :size="15" />
          </button>
        </div>
        <pre>{{ snippet }}</pre>
      </div>
      <div class="step-label">
        <b>02</b>
        <div>
          <strong>启动或重启云开发工作区</strong>
          <p>原 cnb2api 启动脚本会用 REG_TOKEN 将动态地址上报到该账号，探活通过后自动参与路由。</p>
        </div>
      </div>
      <div class="note-box">
        组织额度并不是按仓库独立计算。同一组织的多个工作区共享额度，面板汇总时会按组织去重。
      </div>
    </div>
    <footer class="modal-footer">
      <a
        v-if="account.repo"
        :href="`https://cnb.cool/${account.repo}`"
        class="text-link"
        target="_blank"
        rel="noopener noreferrer"
        >打开 CNB 仓库<ArrowUpRight :size="14" /></a
      ><span v-else class="subtle">请保存配置到对应的 CNB 工作区</span
      ><button class="button primary" @click="emit('close')">
        我已保存配置<Check :size="15" />
      </button></footer
  ></ModalShell>
</template>
