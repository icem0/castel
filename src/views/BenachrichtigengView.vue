<script setup lang="ts">
// Notification tracking page: the per-user minimum-stock alarm signal (sound,
// volume, repetition) plus a test trigger. Not admin-only — every role may
// follow its alarms and enable the signal itself (role-based default, see
// `alarmDefaultFuerRolle`).
//
// The former inline "Benachrichtigungen" block of the settings hub lives here
// now; the hub only links to it.

import { useI18n } from 'vue-i18n'
import MindestbestandBenachrichtigungen from './components/MindestbestandBenachrichtigungen.vue'
import InfoHint from '../components/InfoHint.vue'

const { t } = useI18n()
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.benach.h1') }}</h1>
      <InfoHint :text="t('view.benach.be')" />
    </header>

    <!-- Notification tracking is not admin-only: every role may follow its
         minimum-stock alarms and enable the signal itself. -->
    <div class="card">
      <MindestbestandBenachrichtigungen />
    </div>
  </section>
</template>
