<script setup lang="ts">
import { accountState, stateLabels } from '../console'
import type { Account } from '../types'
defineProps<{ account: Account }>()
</script>

<template>
  <span class="status-badge" :class="accountState(account)"
    ><i />{{ stateLabels[accountState(account)] }}</span
  >
</template>
