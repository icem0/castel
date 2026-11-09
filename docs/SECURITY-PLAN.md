# castel — Security-Audit-Plan und -Stand

**Dieses Dokument enthält Methodik und Prüfstand, keine Fundstellen offener
Lücken.** Einzelne Findings (mit Fundstelle, Angriffspfad, Empfehlung) liegen
ausschließlich in der nicht getrackten Datei `.security/findings.md` (siehe
`.gitignore`). Offene Findings dürfen nicht in Commit-Messages, Branch-Namen,
PR-Titeln oder Work-Package-Titeln erscheinen.

## Verfahren (Methodik)

1. **Vorbereitung:** Vollständige Lektüre der relevanten Dateien (kein bloßes
   Greppen). Für Bereich B wird jede Route einzeln erfasst.
2. **Werkzeuge:** `npm audit --omit=dev` in jedem `package.json`-Ordner (Root +
   `server/`). Ein dedizierter Scanner (z. B. gitleaks) ist nicht installiert;
   dessen Fehlen wird als Hinweis (H-13) vermerkt.
3. **Finding-Kriterien:** Ein Finding benötigt eine Fundstelle (Datei:Zeile)
   und einen konkreten Angriffspfad (wer kann was Schädliches tun). Ohne
   Beleg wird der Punkt als "Hinweis" (H-xx) markiert, nicht als Finding.
4. **Severity:** hoch / mittel / niedrig. Status: open / fixed / accepted /
   false-positive.
5. **Dokumentation:** Jeder Lauf schreibt/aktualisiert `.security/findings.md`
   (nicht getrackt) und den Stand in diesem Dokument (getrackt).

## Bereiche und Checkliste

| Bereich | Inhalt |
|---------|--------|
| **A** | Authentifizierung / Sessions / Tokens: JWT-Secret (≥32 Zeichen erzwungen), Ablauf (JWT_EXPIRES_IN), Passwort-Hashing (argon2id), Refresh-Token (Hash-Speicherung, Rotation), Rate Limit Login, Setup-Erstinstallation. |
| **B** | Autorisierung: JEDE Route/Handler einzeln (Tabelle weiter unten): Route | Auth nötig | Rollenprüfung | Objektbezug/IDOR. Berechtigungsmatrix (Sync-Resolver) pro Entity/Op. |
| **C** | Input-Validierung und Injection: SQL (drizzle parameterisiert, keine String-Konkatenation mit User-Input), Command (pg_dump/pg_restore/unzip/docker argv-Arrays), Path Traversal (Fotos, DATANORM, Backup-ZIP), Deserialisierung (keine), Zukunftszeitstempel (LWW), LIKE-Wildcards. |
| **D** | Frontend: XSS/Output-Encoding (innerHTML-Sinks, DOMPurify), CSP, lokale Speicherung von Tokens (JWT im localStorage, PBKDF2-Cache, Session-PII), Service Worker. |
| **E** | HTTP-Hardening: CORS (fester Origin, nicht wildcard), CSRF/Cookies (Refresh-Cookie httpOnly/sameSite, COOKIE_SECURE), Security-Header (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy), Rate Limits, Fehlermeldungen (kein Leak interner Details). |
| **F** | Secrets/Config: `.env` nicht getrackt, `.env.example` ohne echte Secrets, Default-Werte (COOKIE_SECURE, UPDATE_WEBHOOK_TOKEN), Secrets in Logs oder Git-Historie (kein Scanner installiert → Hinweis). |
| **G** | Dateien: Upload/Download (Fotos: servergenerierter Dateiname, MIME-Allowliste; DATANORM: sichererDateiname), Pfade, Typprüfung, Zip-Slip (Restore nutzt system-unzip), `@fastify/static` (fotoStaticRoutes). |
| **H** | Abhängigkeiten: `npm audit --omit=dev` Ergebnisse (Root, Server), transitive Schwachstellen, CI ohne `npm audit`. |
| **I** | Docker/Compose: User (api läuft als `user: "0:0"` mit Docker-Socket — dokumentierte Design-Entscheidung), Ports (API nicht standardmäßig exponiert), Volumes, Secrets-Übergabe (ENV), pg_dump/Major-Kopplung zu Postgres. |
| **J** | CI/CD: Workflow-Rechte (contents: read, packages: write), Action-Pins, Script-Injection (keine rohen `${{ }}` in `run:` Blocks, Secrets via ENV), Webhook-Absicherung (X-Deploy-Token, `===`-Vergleich, `Link: next`-Token-Forwarding). |
| **K** | Logging und personenbezogene Daten: pino-Logs (keine Secrets, Fehlerobjekte ggf. mit Details), PostgreSQL-Log auf Debug-Level (SQL mit Parametern), Audit-Log. |

## Abdeckungstabelle

Erster vollständiger Lauf: geprüft wurde der Stand `42b01858` (2026-11-06).
Der anschließende Fix-Lauf (`326cd4d`, 2026-11-06) hat die als `fixed`
markierten Findings umgesetzt; die Tabelle führt daher beide SHAs.
"offen" zählt Findings mit Status `open`, "angenommen" mit Status `accepted`
(bewusste Design-Entscheidung — braucht ggf. ein Work Package),
"Fehlbefund" mit Status `false-positive`, "behoben" mit Status `fixed`.
Die Details (Fundstelle, Angriffspfad, Empfehlung) stehen ausschließlich in
`.security/findings.md`.

| Bereich | zuletzt geprüft (Commit-SHA) | Datum | offen | behoben | angenommen | Fehlbefund |
|---------|------------------------------|-------|-------|---------|------------|------------|
| A Authentifizierung / Sessions / Tokens | 42b01858 → 326cd4d | 2026-11-06 | 0 | 3 | 0 | 0 |
| B Autorisierung (Routen einzeln) | 42b01858 → 326cd4d | 2026-11-06 | 0 | 15 | 4 | 2 |
| C Input-Validierung / Injection | 42b01858 → 326cd4d | 2026-11-06 | 0 | 2 | 0 | 0 |
| D Frontend (XSS, CSP, lokale Speicherung) | 42b01858 → 326cd4d | 2026-11-06 | 0 | 2 | 3 | 0 |
| E HTTP-Hardening | 42b01858 → 326cd4d | 2026-11-06 | 0 | 1 | 0 | 0 |
| F Secrets / Config | 42b01858 → 326cd4d | 2026-11-06 | 0 | 0 | 0 | 0 |
| G Dateien (Upload / Download / Pfade) | 42b01858 → 326cd4d | 2026-11-06 | 0 | 0 | 1 | 0 |
| H Abhängigkeiten | 42b01858 → 326cd4d | 2026-11-06 | 0 | 0 | 0 | 0 |
| I Docker / Compose | 42b01858 → 326cd4d | 2026-11-06 | 0 | 0 | 1 | 0 |
| J CI / CD | 42b01858 → 326cd4d | 2026-11-06 | 0 | 2 | 0 | 0 |
| K Logging / personenbezogene Daten | 42b01858 → 326cd4d | 2026-11-06 | 0 | 0 | 1 | 0 |
| **Gesamt** | 42b01858 → 326cd4d | 2026-11-06 | **0** | **25** | **10** | **2** |

## Regeln für Wiederholungsläufe

1. Pro Bereich `git diff --name-only <SHA letzter Lauf>..HEAD` ermitteln; nur
   geänderte Dateien und deren Aufrufer werden neu geprüft. Bereiche ohne Änderung
   werden übersprungen und das vermerkt.
2. Bereiche **A und B werden bei jedem Lauf vollständig geprüft**.
3. Findings mit Status `fixed` werden nur erneut geprüft, wenn sich die Fundstelle
   geändert hat.
4. Jeder Lauf dokumentiert den Stand in dieser Abdeckungstabelle neu (neuer SHA,
   neues Datum, neue offenen/behobenen Zahlen) und aktualisiert
   `.security/findings.md`.
