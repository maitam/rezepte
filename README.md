# Mise en Place – Rezepte

Persönliche Rezept-App als eine HTML-Datei: Rezepte aus Instagram, TikTok und YouTube per Teilen-Menü speichern, Ordner, Wochenplan und Einkaufsliste.

- `index.html` – die ganze App (kein Build, keine Abhängigkeiten)
- `manifest.webmanifest`, `sw.js`, `icon-*.png` – Home-Bildschirm und Offline-Betrieb

Die Rezepte liegen nur lokal im Browser (localStorage). Backup über ⚙️ Mehr → Backup speichern.

## Einrichtung iPhone

1. App-Adresse in Safari öffnen.
2. ⚙️ Mehr → Gemini-Schlüssel eintragen (kostenlos unter aistudio.google.com/apikey).
3. ⚙️ Mehr → Anleitung „Kurzbefehl Rezept speichern“ befolgen.

## Ablauf beim Teilen

Kurzbefehl lädt die Seite des Beitrags → sucht Beschreibung und Titel per Muster → öffnet
`<App-Adresse>#import?u=<Link>&t=<Treffer>` → die App liest das Rezept mit Gemini (ohne Schlüssel: einfacher Parser) und zeigt es zum Prüfen und Speichern.
