# AGENTS.md

## Architecture

- `public/` is the static site with no build step. It contains `index.html` (one-page composition), `styles.css` (brand tokens at the top), `app.js` (availability calendar and AJAX form submit), `thanks.html` (no-JS fallback) and `img/`. Images are always served through `/.netlify/images?url=/img/...&w=...&fm=webp`.
- Page composition, in order: Oxblood hero (`#top`), About, Audio, Residencies, fr. the bloc, Gallery, How to book, booking calendar and form (`#book`, Oxblood), QR card, then the footer (`#contact`) with contact links, the AE mark and the subtle "Built by" builder mark (`.builder`).
- `netlify/functions/submission-created.mts` is the Netlify Forms event function. It forwards the `booking` form to Apps Script as `{secret, booking, ai: null, submissionId, createdAt}`, reading `GOOGLE_APPS_SCRIPT_URL` and `BOOKING_WEBHOOK_SECRET` from env. Its `FIELDS` list must match the form and `recordBooking_`.
- Live IDs (Sheet, Docs folder, calendar, Netlify form/site) are pinned in `CONFIG` at the top of `Code.gs`; `setup()` seeds them into Script Properties.
- `netlify/functions/availability.mts` serves `/api/availability`. It proxies Apps Script `doGet?action=availability` and returns `{live, busy[]}`. If the Apps Script env vars are missing it falls back to a private iCal feed in `AVAILABILITY_ICS_URL`, and with neither it returns `{live: false}`.
- `google-apps-script/Code.gs` is deployed manually by the owner to script.google.com, so it is **not** run by Netlify. Google Sheets is the system of record for the booking workflow and the AppSheet source. Netlify Forms keeps the raw submission log.
- The owner-facing Google Workspace setup steps are in the header comment of `Code.gs` (run `setup()`, then deploy as a web app).

## Brand rules

- Palette: Oxblood `#7A1E1E`, Espresso `#2B261E`, Cream `#F2EDE6`, Ink `#0A0A0A`, Stone `#C0BCB4`. Teal `#006C60` is allowed **only** on the AE monogram's 3D edge.
- Keep the design minimal, editorial and high-contrast. Section grounds alternate between Oxblood, Cream, Ink and Espresso.
- Never use gradients, neon, pure white or gold. Never place Oxblood text on Espresso, or the reverse. Oxblood on Cream or Ink is fine.
- There is **no PTM watermark**. Patty Tiu appears only as the subtle footer builder mark (`.builder`), plus the management contact and contract wording.
- Fonts: Anton for every headline (Cream, uppercase, soft shadow `3px 4px 10px` Ink at 45%). Agrandir for secondary headings and body. It's only licensed in Canva, so Lato (400/700/900) stands in on the web. Don't load Syne, Space Grotesk or Archivo.

## Content rules

- The bio, hero lines and How to Book step titles are approved copy. Don't reword them.
- Event types: Venue residency, Corporate event, Private party, Wedding, Christmas / festive brunch, New Year's Eve, Other. Do not add festival, brand activation or podcast types. Keep the `<option>` list in sync with `RATES` in `Code.gs`.
- Don't add fictional venues or events (for example "Sunset Sessions Beach Club" or "Electronic Collective Festival"). Only use the real residencies and brands in the bio.

## Form conventions

- Form fields in `index.html` must match `recordBooking_` and `HEADERS` in `Code.gs`, and `FIELDS` in `submission-created.mts`. Sheet columns are looked up by header name.
- Multiple `vibe` checkboxes are joined into one comma-separated value in `app.js` before submit.
- `app.js` relies on these hooks: `form[name="booking"]`, `.cal__grid`, `.cal__title`, `[data-cal]`, `[data-cal-status]`, `.success`, `[data-success-*]` and `.form__error`. Keep them when restyling.

## Integration notes

- Apps Script can't read request headers, so the shared secret travels in the JSON body (POST) or the query string (GET).
- AppSheet edits don't fire `onEdit`, so status automation polls on a 5-minute time trigger, using the `Last Processed Status` column.
- Env vars: `GOOGLE_APPS_SCRIPT_URL` and `BOOKING_WEBHOOK_SECRET` (optional fallback: `AVAILABILITY_ICS_URL`). Read them with `Netlify.env.get`.

## Checklist before shipping UI changes

- Test the hero at 1440px, 900px and 375px. The Anton name must not overflow.
- Check that the calendar loads, dates can be picked, and booked dates are struck through.
- Submit a test booking. The success panel and the calendar hold link should appear.
