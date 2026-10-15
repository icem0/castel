export default {
  app: {
    title: 'castel',
    nav: {
      dashboard: 'Dashboard',
      artikel: 'Items',
      buchungen: 'Transactions',
      standorte: 'Locations',
      einstellungen: 'Settings',
    },
  },
  view: {
    dashboard: {
      h1: 'Dashboard',
      leer: 'No data yet. Create a location and an item first.',
    },
    artikel: {
      h1: 'Items',
      neu: 'New item',
      suche: 'Search (title, type, order no.)',
      filter: {
        typ: 'Type',
        typAlle: '- all -',
        status: 'Status',
        statusAlle: 'all',
      },
      status: {
        verfuegbar: 'available',
        reserviert: 'reserved',
        gesperrt: 'locked',
        ausgesondert: 'discarded',
        archiviert: 'archived',
      },
      spalten: {
        titel: 'Title',
        typ: 'Type',
        bestand: 'Stock',
      },
      leer: 'No items found.',
      detail: {
        h1: 'Item',
        bestandProStandort: 'Stock per location',
        historie: 'History',
        buchen: 'Record',
        archivieren: 'Archive',
        archivierenFrage: 'Archive this item?',
        archiviert: 'archived',
      },
      form: {
        h1: 'New item',
        titel: 'Title',
        typ: 'Type',
        typOptional: '(optional)',
        typKeiner: '— no type —',
        status: 'Status',
        lieferant: 'Supplier',
        ve: 'Packaging unit',
        mindestbestand: 'Minimum stock',
        bestellnummer: 'Order no.',
        barcode: 'Barcode',
        barcodeHint: 'EAN, Code128 or QR. Used by the scanner.',
        speichern: 'Save',
        abbrechen: 'Cancel',
        pflicht: 'Required',
      },
    },
    buchung: {
      h1: 'Transactions',
      leer: 'No transactions yet.',
      spalten: {
        zeit: 'Time',
        artikel: 'Item',
        standort: 'Location',
        menge: '± Qty',
        typ: 'Type',
        projekt: 'Project',
        von: 'User',
      },
      form: {
        h1: 'New transaction',
        typ: 'Type',
        typen: {
          einlagerung: 'Put-away',
          entnahme: 'Removal',
          umlagerung: 'Transfer',
          inventur: 'Inventory',
          kommission: 'Picking',
          storno: 'Cancellation',
        },
        artikel: 'Item',
        standort: 'Location',
        zielstandort: 'Destination',
        menge: 'Quantity',
        sollMenge: 'Target qty',
        projekt: 'Project no.',
        kommentar: 'Comment',
        speichern: 'Save',
        abbrechen: 'Cancel',
        warnNegativ: 'Warning: stock is below required quantity. Continue?',
      },
    },
    kommission: {
      h1: 'Commission',
      erklaerung:
        'This cancels the original transaction and posts a new one carrying the new project. Stock remains identical.',
      neuesProjekt: 'New project',
      speichern: 'Run commission',
      abbrechen: 'Cancel',
    },
    standort: {
      h1: 'Locations',
      neu: 'New location',
      spalten: {
        name: 'Name',
        typ: 'Type',
        projekt: 'Project',
        kennzeichen: 'Plate',
        standard: 'Default',
      },
      typen: {
        lager: 'Warehouse',
        auto: 'Vehicle',
        baustelle: 'Site',
        extern: 'external',
      },
      form: {
        name: 'Name',
        typ: 'Type',
        projekt: 'Project',
        kennzeichen: 'Plate',
        standard: 'set as default',
        speichern: 'Save',
        abbrechen: 'Cancel',
      },
      filter: {
        archivierteAnzeigen: 'Show archived',
      },
      wiederherstellen: 'Restore',
      leer: 'No locations yet.',
    },
    settings: {
      h1: 'Settings',
      sprache: 'Language',
      sprachen: { de: 'Deutsch', en: 'English' },
      benutzer: 'Display name (used on transactions)',
      standardStandort: 'Default location',
      companyName: 'Company Name',
      companyNameHint: 'Displayed in the header and reports. Only configurable by admins.',
      speichern: 'Save',
      gespeichert: 'saved.',
      nichtGelegt: 'not set',
      typVerwaltung: {
        titel: 'Item types',
        hint: 'Order = display order. Types appear in the item list filter and as a choice in the item form.',
        neuerTyp: 'New type',
        hinzufuegen: 'Add',
        konfigurierte: 'Configured types',
        verwaiste: 'Orphaned types (only in items)',
        uebernehmen: 'Adopt',
        leer: 'No types configured.',
        anzahlEins: '1 item',
        anzahlViele: '{n} items',
        entfernenGenutzt: 'Type is still in use by items — reassign or archive first',
        entfernen: 'Remove',
        nachOben: 'move up',
        nachUnten: 'move down',
        istOben: 'is at top',
        istUnten: 'is at bottom',
        speicherStatus: 'saved',
        fehlerLeer: 'Name must not be empty.',
        fehlerDuplikat: 'is already in the list.',
      },
    },
    common: {
      neu: 'New',
      abbrechen: 'Cancel',
      speichern: 'Save',
      ja: 'Yes',
      nein: 'No',
      optional: '(optional)',
    },
  },
  auth: {
    error: {
      emailRequired: 'Please enter your email address.',
      passwordRequired: 'Please enter your password.',
      credentialsRequired: 'Please enter email and password.',
      // Server did not respond (network, DNS, CORS, 5xx without body).
      // Concrete browser / proxy messages like "Failed to fetch"
      // or "getaddrinfo ENOTFOUND db" are summarised here.
      serverUnreachable: 'Server unreachable. Please check your internet or VPN connection.',
      // Offline login with cached credentials failed:
      // no cache entry for this email, or the password does not match
      // the cached hash.
      offlineNoCache: 'Offline login not possible: no cached entry or wrong password.',
      // Inconsistency: password verified, but the credential entry is
      // gone (localStorage was cleared).
      cacheLost: 'Internal error: credential cache lost.',
      // Password is fine, but no JWT in the cache (first login was never online).
      jwtMissing: 'Offline login is possible, but no saved token. Please sign in online first.',
      // JWT has expired and the server is not reachable.
      jwtExpired: 'Session expired. Please sign in online to obtain a new token.',
      // Generic network error on another auth call (e.g. change password).
      // Raw browser messages are not forwarded.
      network: 'Server unreachable. Please check your internet or VPN connection.',
      // Status check during LoginView mount: server unreachable,
      // offline login with cached credentials will be tried.
      serverUnreachableHint:
        'Server unreachable. You can sign in with cached data if you have previously signed in online here.',
    },
  },
}
