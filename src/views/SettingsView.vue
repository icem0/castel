<script setup lang="ts">
// The settings hub is now a pure directory: every menu point links to its own
// page (inline forms moved to Account / Benachrichtigeng / General pages).
//
// Two navigation aids are built in:
//   - A live filter at the very top: typing narrows the menu points in real
//     time (label, explanation and category title are searched).
//   - Every menu point carries an InfoHint badge to its right: hover shows the
//     page's explanation, click/tap pins it open (touch devices, no hover).
//
// Permission visibility stays client-side (`auth.hat`); the router gate keeps
// direct calls safe, the menu just does not show points the user cannot open.

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import AppIcon from '../components/AppIcon.vue'
import InfoHint from '../components/InfoHint.vue'

const { t } = useI18n()
const settings = useSettingsStore()
const auth = useAuthStore()

// Test hook: a mounted SettingsView can be seeded with an initial search
// query; typing into the input afterwards works as usual in the app.
const props = defineProps<{
  initialQuery?: string
}>()

type MenuItem = {
  to: string
  icon: string
  labelKey: string
  infoKey: string
  darf?: () => boolean
}

const menus: Array<{ titleKey: string; icon: string; items: MenuItem[] }> = [
  {
    titleKey: 'view.settings.personal',
    icon: 'account',
    items: [
      {
        to: '/einstellungen/account',
        icon: 'account',
        labelKey: 'view.settings.account',
        infoKey: 'view.settings.menu.info.account',
      },
      {
        to: '/passwort-aendern',
        icon: 'account',
        labelKey: 'view.settings.passwortAendern',
        infoKey: 'view.settings.menu.info.passwortAendern',
      },
      {
        to: '/info',
        icon: 'info',
        labelKey: 'view.settings.ersteSchritte',
        infoKey: 'view.settings.menu.info.ersteSchritte',
      },
    ],
  },
  {
    titleKey: 'view.settings.benachrichtigengs',
    icon: 'notifications',
    items: [
      {
        to: '/einstellungen/benachrichtigengs',
        icon: 'notifications',
        labelKey: 'view.settings.benachConfig',
        infoKey: 'view.settings.menu.info.benach',
      },
      {
        to: '/einstellungen/mindestbestand',
        icon: 'mindestbestand',
        labelKey: 'view.settings.mindestbestandPanel',
        infoKey: 'view.settings.menu.info.mindestbestandPanel',
      },
    ],
  },
  {
    titleKey: 'view.settings.lager',
    icon: 'dashboard',
    items: [
      {
        to: '/standorte',
        icon: 'standorte',
        labelKey: 'view.standort.h1',
        infoKey: 'view.settings.menu.info.standorte',
        darf: () => auth.hat('standort.schreiben'),
      },
    ],
  },
  {
    titleKey: 'view.settings.analyse',
    icon: 'inventur',
    items: [
      {
        to: '/einstellungen/inventur',
        icon: 'inventur',
        labelKey: 'view.inventur.h1',
        infoKey: 'view.settings.menu.info.inventur',
        darf: () => auth.hat('inventur.lesen'),
      },
      {
        to: '/einstellungen/inventur/archiv',
        icon: 'inventur',
        labelKey: 'view.settings.inventurArchiv',
        infoKey: 'view.settings.menu.info.inventurArchiv',
        darf: () => auth.hat('inventur.lesen'),
      },
    ],
  },
  {
    titleKey: 'view.settings.werkzeuge',
    icon: 'tools',
    items: [
      {
        to: '/akkutausch',
        icon: 'akkutausch',
        labelKey: 'view.akkutausch.h1',
        infoKey: 'view.settings.menu.info.akkutausch',
        darf: () => settings.settings.akkutauschAktiv,
      },
      {
        to: '/etiketten',
        icon: 'etiketten',
        labelKey: 'view.barcode.h1',
        infoKey: 'view.settings.menu.info.etiketters',
      },
      {
        to: '/import',
        icon: 'tools',
        labelKey: 'view.settings.csvImport',
        infoKey: 'view.settings.menu.info.csvImport',
        darf: () => auth.hat('import.fuehren'),
      },
    ],
  },
  {
    titleKey: 'view.settings.stammdaten',
    icon: 'stammdaten',
    items: [
      {
        to: '/einstellungen/artikel-typen',
        icon: 'stammdaten',
        labelKey: 'view.artikelTypen.h1',
        infoKey: 'view.settings.menu.info.artikelTypen',
        darf: () => auth.hat('stammdaten.verwalten'),
      },
      {
        to: '/einstellungen/akku-typen',
        icon: 'stammdaten',
        labelKey: 'view.akkuTypen.h1',
        infoKey: 'view.settings.menu.info.akkuTypen',
        darf: () => auth.hat('stammdaten.verwalten') && settings.settings.akkutauschAktiv,
      },
      {
        to: '/einstellungen/kommissionen',
        icon: 'stammdaten',
        labelKey: 'view.kommissionen.h1',
        infoKey: 'view.settings.menu.info.kommissionen',
        darf: () => auth.hat('stammdaten.verwalten'),
      },
      {
        to: '/einstellungen/hersteller',
        icon: 'stammdaten',
        labelKey: 'view.hersteller.h1',
        infoKey: 'view.settings.menu.info.hersteller',
        darf: () => auth.hat('stammdaten.verwalten'),
      },
      {
        to: '/einstellungen/artikel-kataloge',
        icon: 'stammdaten',
        labelKey: 'view.settings.artikelKataloge',
        infoKey: 'view.settings.menu.info.artikelKataloge',
      },
    ],
  },
  {
    titleKey: 'view.settings.administration',
    icon: 'administration',
    items: [
      {
        to: '/einstellungen/general',
        icon: 'administration',
        labelKey: 'view.settings.general',
        infoKey: 'view.settings.menu.info.general',
        darf: () => auth.hat('globalEinstellung'),
      },
      {
        to: '/einstellungen/user',
        icon: 'administration',
        labelKey: 'view.settings.benutzerVerwaltung',
        infoKey: 'view.settings.menu.info.benutzerVerwaltung',
        darf: () => auth.hat('benutzer.verwalten'),
      },
      {
        to: '/einstellungen/rollen',
        icon: 'administration',
        labelKey: 'view.settings.rollenVerwaltung',
        infoKey: 'view.settings.menu.info.rollenVerwaltung',
        darf: () => auth.hat('benutzer.verwalten'),
      },
      {
        to: '/einstellungen/entwicklung',
        icon: 'administration',
        labelKey: 'view.settings.entwicklung',
        infoKey: 'view.settings.menu.info.entwicklung',
        darf: () => auth.hat('entwicklung'),
      },
    ],
  },
  {
    titleKey: 'view.settings.daten',
    icon: 'daten',
    items: [
      {
        to: '/einstellungen/geraet',
        icon: 'daten',
        labelKey: 'view.settings.geraet',
        infoKey: 'view.settings.menu.info.geraet',
      },
      {
        to: '/einstellungen/backup',
        icon: 'daten',
        labelKey: 'view.settings.backup',
        infoKey: 'view.settings.menu.info.backup',
        darf: () => auth.hat('backup.verwalten'),
      },
      {
        to: '/einstellungen/api-keys',
        icon: 'daten',
        labelKey: 'view.settings.apiKeys',
        infoKey: 'view.settings.menu.info.apiKeys',
        darf: () => auth.hat('apiKey.verwalten'),
      },
    ],
  },
]

function darfs(menu: MenuItem): boolean {
  return menu.darf?.() ?? true
}

function matches(menu: MenuItem, sectionTitleKey: string, query: string): boolean {
  const haystack = [t(menu.labelKey), t(menu.infoKey), t(sectionTitleKey)].join(' ').toLowerCase()
  return haystack.includes(query)
}

const menuQuery = ref(props.initialQuery ?? '')

const angeigt = computed(() => {
  const q = menuQuery.value.trim().toLowerCase()
  const out: Array<{ titleKey: string; icon: string; items: MenuItem[] }> = []
  for (const s of menus) {
    const visible = s.items.filter(darfs)
    if (visible.length === 0) continue
    if (q === '' || t(s.titleKey).toLowerCase().includes(q)) {
      out.push({ titleKey: s.titleKey, icon: s.icon, items: visible })
      continue
    }
    const hits = visible.filter((m) => matches(m, s.titleKey, q))
    if (hits.length > 0) out.push({ titleKey: s.titleKey, icon: s.icon, items: hits })
  }
  return out
})
</script>

<template>
  <section class="view">
    <header class="view-head">
      <h1>{{ t('view.settings.h1') }}</h1>
    </header>

    <label class="menu-search">
      <input
        v-model="menuQuery"
        type="search"
        :aria-label="t('view.settings.menu.suche')"
        :placeholder="t('view.settings.menu.suche')"
      />
    </label>

    <p v-if="angeigt.length === 0" class="hint">{{ t('view.settings.menu.leer') }}</p>

    <template v-for="s in angeigt" :key="s.titleKey">
      <h2>
        <AppIcon :name="s.icon" />
        {{ t(s.titleKey) }}
      </h2>
      <div class="card quick-links">
        <div v-for="m in s.items" :key="m.to" class="menu-row">
          <RouterLink :to="m.to"> <AppIcon :name="m.icon" />{{ t(m.labelKey) }} </RouterLink>
          <InfoHint :text="t(m.infoKey)" />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.quick-links {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.4rem 0.5rem;
}
.menu-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-right: 0.35rem;
  border-radius: var(--radius-sm, 6px);
  transition: background-color 0.15s ease-out;
}
.menu-row:hover {
  background: var(--accent-bg, rgba(99, 102, 241, 0.08));
}
.menu-row a,
.menu-row button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  padding: 0.65rem 0.7rem;
  font-weight: 500;
  color: var(--text-strong, inherit);
  border-radius: inherit;
}
.menu-row .info-hint {
  margin-left: auto;
  flex: none;
}
.menu-search {
  display: block;
  margin-bottom: 0.85rem;
}
.menu-search input {
  width: 100%;
  max-width: 26rem;
  box-sizing: border-box;
  padding: 0.6rem 0.85rem;
  border-radius: var(--radius, 8px);
  background: var(--bg-input, transparent);
  border: 1px solid var(--border, #ccc);
  transition: border-color 0.15s ease-out;
}
.menu-search input:focus-visible {
  outline: none;
  border-color: var(--accent-border, #6366f1);
}
</style>
