export default {
  app: {
    title: 'castel',
    nav: {
      dashboard: 'Dashboard',
      artikel: 'Artikel',
      buchungen: 'Buchungen',
      scan: 'Scan',
      standorte: 'Standorte',
      einstellungen: 'Einstellungen',
    },
  },
  view: {
    dashboard: {
      h1: 'Dashboard',
      leer: 'Noch keine Daten. Lege im Menü "Standorte" und "Artikel" etwas an.',
    },
    info: {
      h1: 'Informationen',
      untertitel:
        'Anleitungen, Tipps und Hilfe für castel. Installiere die App als Web-App auf deinem Gerät, damit sie sich wie eine native App verhält.',
      iosTitel: 'Web-App unter iOS (Safari) installieren',
      iosS1: 'Öffne diese Seite in Safari auf deinem iPhone oder iPad.',
      iosS2:
        'Tippe unten in der Safari-Leiste auf den Teilen-Button (Quadrat mit Pfeil nach oben).',
      iosS3: 'Scrolle im Teilen-Menü nach unten und wähle "Zum Home-Bildschirm".',
      iosS4: 'Vergib einen kurzen Namen (z. B. "castel") und tippe auf "Hinzufügen".',
      iosS5:
        'Das castel-Symbol erscheint auf deinem Home-Bildschirm. Öffne die App immer darüber — nur so funktioniert der Offline-Modus zuverlässig.',
      iosHinweis:
        'Hinweis: Andere Browser (Chrome, Firefox) können auf iOS keine Web-Apps installieren. Verwende Safari.',
      androidTitel: 'Web-App unter Android installieren',
      androidVariante:
        'Die Schritte unterscheiden sich je nach Browser. Wähle deinen Standard-Browser:',
      androidChromeTitel: 'Google Chrome',
      androidChromeS1:
        'Öffne diese Seite in Chrome und tippe rechts oben auf das Drei-Punkte-Menü.',
      androidChromeS2: 'Wähle "App installieren" oder "Zum Startbildschirm hinzufügen".',
      androidChromeS3:
        'Bestätige mit "Installieren". castel erscheint als eigenständige App in deiner App-Übersicht.',
      androidSamsungTitel: 'Samsung Internet',
      androidSamsungS1:
        'Tippe unten in der Mitte auf das Menü (drei Striche) und wähle "Seite hinzufügen".',
      androidSamsungS2: 'Wähle "Zum Startbildschirm".',
      androidSamsungS3:
        'Bestätige mit "Hinzufügen". castel liegt jetzt als Symbol auf deinem Startbildschirm.',
      androidFirefoxTitel: 'Mozilla Firefox',
      androidFirefoxS1:
        'Tippe rechts oben auf die drei Punkte und öffne "Erweiterte Einstellungen".',
      androidFirefoxS2: 'Wähle "Installation" und tippe auf "Installieren".',
      androidFirefoxS3:
        'Bestätige die Installation. Firefox unterstützt PWAs allerdings nur eingeschränkt — Chrome oder Samsung Internet sind die bessere Wahl.',
      warumTitel: 'Warum installieren?',
      warum1:
        'Die Web-App startet schneller und fühlt sich an wie eine native App — ohne Adressleiste, ohne Browser-UI.',
      warum2:
        'Auch ohne Internet funktioniert alles (offline-fähig). Buchungen werden lokal gespeichert und automatisch synchronisiert, sobald du wieder online bist.',
      warum3:
        'Du bekommst Zugriff auf die Kamera für den Barcode-Scanner — nur als installierte App darf castel die Kamera nutzen.',
      warum4:
        'Updates werden beim nächsten Start automatisch geladen — kein App-Store, kein Hand-Aufhalten.',
      problemeTitel: 'Häufige Probleme',
      faq1Frage: 'Die Installations-Option fehlt im Browser.',
      faq1Antwort:
        'PWAs müssen über HTTPS ausgeliefert werden. Wenn du castel über eine HTTP-Adresse oder eine unsichere Verbindung öffnest, zeigen die Browser die Installation nicht an. Verwende die offizielle HTTPS-URL.',
      faq2Frage: 'Ich finde die App nach der Installation nicht wieder.',
      faq2Antwort:
        'Auf iOS: schau auf deinem Home-Bildschirm nach. Auf Android: öffne die App-Übersicht (Wisch vom unteren Bildschirmrand nach oben).',
      faq3Frage: 'Muss ich die App installieren, um castel zu nutzen?',
      faq3Antwort:
        'Nein — du kannst castel auch normal als Webseite im Browser benutzen. Die Installation bietet nur den besseren Offline-Modus und schnelleren Zugriff.',
      zumDashboard: 'Zum Dashboard',
      onboardingErneut: 'Tutorial erneut zeigen',
    },
    artikel: {
      h1: 'Artikel',
      neu: 'Neuer Artikel',
      suche: 'Suche (Titel, Typ, Bestellnummer)',
      filter: {
        typ: 'Typ',
        typAlle: '- alle -',
        status: 'Status',
        statusAlle: 'alle',
        standort: 'Standort',
        standortAlle: 'alle Standorte',
      },
      status: {
        verfuegbar: 'verfügbar',
        reserviert: 'reserviert',
        gesperrt: 'gesperrt',
        ausgesondert: 'ausgesondert',
        archiviert: 'archiviert',
      },
      spalten: {
        titel: 'Titel',
        typ: 'Typ',
        bestand: 'Bestand',
        status: 'Status',
      },
      leer: 'Keine Artikel gefunden.',
      detail: {
        h1: 'Artikel',
        bestandProStandort: 'Bestand pro Standort',
        historie: 'Historie',
        buchen: 'Buchen',
        bearbeiten: 'Bearbeiten',
        statusAdminHint: 'Nur Admins dürfen den Status ändern.',
        archivieren: 'Archivieren',
        archivierenFrage: 'Diesen Artikel archivieren?',
        archiviert: 'archiviert',
      },
      form: {
        h1: 'Neuer Artikel',
        titel: 'Titel',
        typ: 'Typ',
        typOptional: '(optional)',
        typKeiner: '— kein Typ —',
        status: 'Status',
        lieferant: 'Lieferant',
        ve: 'Verpackungseinheit',
        mindestbestand: 'Mindestbestand',
        bestellnummer: 'Bestellnummer',
        barcode: 'Barcode',
        barcodeHint: 'EAN, Code128 oder QR. Wird vom Scanner gelesen.',
        speichern: 'Speichern',
        abbrechen: 'Abbrechen',
        pflicht: 'Pflichtfeld',
      },
    },
    buchung: {
      h1: 'Buchungen',
      leer: 'Noch keine Buchungen.',
      spalten: {
        zeit: 'Zeit',
        artikel: 'Artikel',
        standort: 'Standort',
        menge: '± Menge',
        typ: 'Typ',
        projekt: 'Kommission',
        von: 'Benutzer',
      },
      form: {
        h1: 'Neue Buchung',
        typ: 'Typ',
        typen: {
          einlagerung: 'Einlagerung',
          entnahme: 'Entnahme',
          umlagerung: 'Umlagerung',
          inventur: 'Inventur',
          kommission: 'Kommission',
          storno: 'Storno',
        },
        artikel: 'Artikel',
        artikelSuchen: 'Artikel suchen…',
        keinTreffer: 'Kein passender Artikel.',
        sucheLeeren: 'Auswahl aufheben',
        standort: 'Standort',
        zielstandort: 'Zielstandort',
        menge: 'Menge',
        sollMenge: 'Soll-Menge',
        projekt: 'Kommission',
        kommentar: 'Kommentar',
        speichern: 'Speichern',
        abbrechen: 'Abbrechen',
        warnNegativ: 'Achtung: Bestand kleiner als benötigte Menge. Trotzdem fortfahren?',
      },
    },
    kommission: {
      h1: 'Kommission',
      erklaerung:
        'Diese Aktion storniert die Original-Buchung und legt eine neue Buchung mit dem gewählten Projekt an. Der Bestand bleibt gleich.',
      neuesProjekt: 'Neues Projekt',
      speichern: 'Kommission ausführen',
      abbrechen: 'Abbrechen',
    },
    standort: {
      h1: 'Standorte',
      neu: 'Neuer Standort',
      spalten: {
        name: 'Name',
        typ: 'Typ',
        kommission: 'Kommission',
        standard: 'Standard',
      },
      typen: {
        lager: 'Lager',
        auto: 'Auto',
        baustelle: 'Baustelle',
        extern: 'extern',
      },
      form: {
        name: 'Name',
        typ: 'Typ',
        kommission: 'Kommission',
        speichern: 'Speichern',
        abbrechen: 'Abbrechen',
      },
      loeschen: 'Löschen',
      wiederherstellen: 'Wiederherstellen',
      leer: 'Noch keine Standorte.',
    },
    settings: {
      h1: 'Einstellungen',
      sprache: 'Sprache',
      sprachen: { de: 'Deutsch', en: 'English' },
      benutzer: 'Anzeigename (für Buchungen)',
      standardStandort: 'Standard-Standort',
      companyName: 'Firmenzeichen',
      companyNameHint: 'Wird im Header und in Berichten angezeigt. Nur für Admins konfigurierbar.',
      speichern: 'Speichern',
      gespeichert: 'gespeichert.',
      nichtGelegt: 'noch nicht festgelegt',
      barcodeTyp: 'Barcode-Format',
      barcodeTypHint: 'Wird in der Artikel-Detail-Ansicht zur Darstellung des Barcodes verwendet.',
      onboardingAusblenden: 'Onboarding-Tutorial nicht mehr anzeigen',
      onboardingAusblendenHint:
        'Blendet das "Erste Schritte"-Modal bei zukünftigen Logins auf allen Geräten aus. Über "Tutorial erneut zeigen" unter Informationen lässt es sich wieder einschalten.',
    },
    artikelTypen: {
      h1: 'Artikel-Typen',
      hint: 'Reihenfolge = Anzeige-Reihenfolge. Typen erscheinen im Filter der Artikel-Liste und als Auswahl im Artikel-Formular.',
      neuerTyp: 'Neuer Typ',
      hinzufuegen: 'Hinzufügen',
      konfigurierte: 'Konfigurierte Typen',
      verwaiste: 'Verwaiste Typen (nur in Artikeln)',
      uebernehmen: 'Übernehmen',
      leer: 'Keine Typen konfiguriert.',
      anzahlEins: '1 Artikel',
      anzahlViele: '{n} Artikel',
      entfernenGenutzt: 'Typ wird noch von Artikeln verwendet – erst zuordnen oder archivieren',
      entfernen: 'Entfernen',
      nachOben: 'nach oben',
      nachUnten: 'nach unten',
      istOben: 'ist oben',
      istUnten: 'ist unten',
      speicherStatus: 'gespeichert',
      fehlerLeer: 'Name darf nicht leer sein.',
      fehlerDuplikat: 'ist bereits in der Liste.',
    },
    barcode: {
      h1: 'Barcode-Etiketten',
      artikel: 'Artikel',
      artikelWaehlen: '– Artikel wählen –',
      wert: 'Barcode-Wert',
      wertHint:
        'Z. B. EAN-13, Code128 oder Code39. Leer lassen, um den vorhandenen Barcode des Artikels anzuzeigen.',
      format: 'Format',
      formatCode128: 'Code128',
      formatEAN13: 'EAN-13',
      formatCode39: 'Code39',
      hintCode128: 'Beliebige Zeichen (ASCII).',
      hintEAN13: 'Genau 13 Ziffern.',
      hintCode39: 'A–Z, 0–9 und - . $ / + % Leerzeichen.',
      zuArtikelSpeichern: 'Am Artikel speichern',
      bildSpeichern: 'Bild speichern',
      speichert: 'Speichert',
      gespeichert: 'Barcode am Artikel gespeichert.',
    },
    kommissionen: {
      h1: 'Kommissionen',
      hint: 'Reihenfolge = Anzeige-Reihenfolge. Kommissionen erscheinen im Buchungsformular als Projekt-Eintrag.',
      neueKommission: 'Neue Kommission',
      hinzufuegen: 'Hinzufügen',
      konfigurierte: 'Konfigurierte Kommissionen',
      verwaiste: 'Verwaiste Kommissionen (nur in Buchungen)',
      uebernehmen: 'Übernehmen',
      leer: 'Keine Kommissionen konfiguriert.',
      anzahlEins: '1 Buchung',
      anzahlViele: '{n} Buchungen',
      entfernenGenutzt:
        'Kommission wird noch in Buchungen verwendet – erst zuordnen oder stornieren',
      entfernen: 'Entfernen',
      nachOben: 'nach oben',
      nachUnten: 'nach unten',
      istOben: 'ist oben',
      istUnten: 'ist unten',
      speicherStatus: 'gespeichert',
      fehlerLeer: 'Name darf nicht leer sein.',
      fehlerDuplikat: 'ist bereits in der Liste.',
    },
    common: {
      neu: 'Neu',
      abbrechen: 'Abbrechen',
      speichern: 'Speichern',
      ja: 'Ja',
      nein: 'Nein',
      optional: '(optional)',
    },
    backup: {
      exportieren: 'Backup exportieren',
      wiederherstellen: 'Backup wiederherstellen',
      datei: 'Backup-Datei (.json)',
      laeuft: 'Stelle wieder her…',
      bestaetigen:
        'Ich bestätige, dass alle aktuellen lokalen Daten durch das Backup überschrieben werden.',
      bestaetigungErforderlich: 'Bitte bestätigen, bevor das Backup wiederhergestellt wird.',
      fehlerParse: 'Die Datei konnte nicht als JSON gelesen werden.',
      fehlerSchema: 'Ungültiges Backup (unbekanntes Schema).',
      fehler: 'Wiederherstellung fehlgeschlagen: {msg}',
      hinweis:
        'Wählt eine zuvor exportierte castel-Backup-Datei (.json) aus. Alle bestehenden Daten werden ersetzt.',
    },
    passwortAendern: {
      h1Erzwungen: 'Neues Passwort setzen',
      h1Frei: 'Passwort ändern',
      hintErzwungen:
        'Dein Passwort wurde vom Admin zurückgesetzt. Bitte vergib gleich ein neues — damit bist du startklar.',
      aktuellesPw: 'Aktuelles Passwort',
      neuesPw: 'Neues Passwort (≥ 8 Zeichen, mind. 1 Ziffer, 1 Buchstabe)',
      neuesPwPatternTitel: 'Mindestens 8 Zeichen, davon mindestens 1 Ziffer und 1 Buchstabe',
      neuesPwBestaetigen: 'Neues Passwort bestätigen',
      fehlerPwStimmtNicht: 'Neue Passwörter stimmen nicht überein.',
      speichernLaufend: 'Speichere …',
    },
    mindestbestand: {
      title: 'Mindestbestand',
      hint: 'Hier siehst du alle Buchungen, die einen Artikel unter seinen Mindestbestand gedrückt haben. Die Liste wird vom Server gefüllt (nur Admins sehen sie).',
      back: 'Zurück',
      empty: 'Keine Ereignisse im gewählten Zeitraum.',
      openPanel: 'Alle anzeigen',
      openArtikel: 'Artikel öffnen',
      bestand: 'Bestand {bestand} / Soll {mindest}',
      filterArtikel: 'Artikel',
      filterStandort: 'Standort',
      alleArtikel: 'Alle Artikel',
      alleStandorte: 'Alle Standorte',
      colZeit: 'Zeit',
      colArtikel: 'Artikel',
      colStandort: 'Standort',
      colBestand: 'Bestand',
      colMindest: 'Mindest',
      colDefizit: 'Defizit',
    },
  },
  onboarding: {
    titel: 'Erste Schritte mit castel',
    untertitel:
      'castel läuft als Web-App. Installiere sie auf deinem Gerät — dann funktioniert sie auch offline und du hast schnellen Zugriff vom Startbildschirm.',
    tab: {
      ios: 'iOS (Safari)',
      android: 'Android',
      desktop: 'Desktop',
    },
    ios: {
      s1: 'Öffne diese Seite in Safari (nicht Chrome oder Firefox).',
      s2: 'Tippe unten auf den Teilen-Button (Quadrat mit Pfeil).',
      s3: 'Wähle "Zum Home-Bildschirm".',
      s4: 'Vergib einen Namen (z. B. "castel") und tippe auf "Hinzufügen".',
      s5: 'Öffne castel immer über das neue Symbol auf dem Home-Bildschirm.',
    },
    android: {
      s1: 'Öffne diese Seite in Chrome oder Samsung Internet.',
      s2: 'Tippe auf das Menü (drei Punkte) und wähle "App installieren" oder "Zum Startbildschirm hinzufügen".',
      s3: 'Bestätige — castel erscheint als App in deiner App-Übersicht.',
    },
    desktop: {
      s1: 'Klicke rechts in der Adressleiste auf das Installieren-Symbol.',
      s2: 'Bestätige — castel öffnet sich künftig in einem eigenen Fenster.',
    },
    weiter: 'Weiter',
    zurueck: 'Zurück',
    fertig: 'Verstanden',
    spaeter: 'Später',
    schliessen: 'Tutorial schließen',
    mehrErfahren: 'Mehr erfahren (ausführliche Anleitung)',
  },
  auth: {
    error: {
      emailRequired: 'Bitte eine E-Mail eingeben.',
      passwordRequired: 'Bitte ein Passwort eingeben.',
      credentialsRequired: 'Bitte E-Mail und Passwort eingeben.',
      // Server antwortet nicht (Netzwerk, DNS, CORS, 5xx ohne Body).
      // Konkrete Browser-/Proxy-Fehlermeldungen wie "Failed to fetch"
      // oder "getaddrinfo ENOTFOUND db" werden hier zusammengefasst.
      serverUnreachable: 'Server nicht erreichbar. Bitte Internet- oder VPN-Verbindung prüfen.',
      // Offline-Login mit gecachten Credentials gescheitert:
      // kein Cache-Eintrag fuer diese E-Mail oder das Passwort stimmt
      // nicht mit dem gecachten Hash ueberein.
      offlineNoCache: 'Offline-Login nicht möglich: kein gecachter Eintrag oder falsches Passwort.',
      // Inkonsistenz: Passwort wurde verifiziert, aber der Credential-
      // Eintrag ist zwischenzeitlich verschwunden (localStorage geloescht).
      cacheLost: 'Interner Fehler: Credential-Cache verloren.',
      // Passwort OK, aber kein JWT mehr im Cache (erster Login war nie online).
      jwtMissing:
        'Offline-Login möglich, aber kein gespeichertes Token. Bitte zuerst online anmelden.',
      // JWT ist abgelaufen und der Server ist nicht erreichbar.
      jwtExpired: 'Sitzung abgelaufen. Bitte online anmelden, um einen neuen Token zu erhalten.',
      // Generischer Netzwerkfehler bei einem anderen Auth-Aufruf
      // (z. B. Passwort aendern). Rohmeldungen des Browsers werden hier
      // nicht durchgereicht.
      network: 'Server nicht erreichbar. Bitte Internet- oder VPN-Verbindung prüfen.',
      // Status-Check beim LoginView-Mount: Server nicht erreichbar,
      // Offline-Login mit gecachten Daten wird versucht.
      serverUnreachableHint:
        'Server nicht erreichbar. Du kannst dich mit gecachten Daten anmelden, wenn du hier schon einmal online angemeldet warst.',
    },
  },
}
