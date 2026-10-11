/**
 * AIRA EDWARD — Booking Automation (Google Apps Script)
 *
 * The central brain behind the Netlify booking page:
 *   Netlify form → (Gemini analysis) → doPost() here →
 *     Google Sheets   master booking database (also the AppSheet data source)
 *     Google Calendar tentative HOLD with location + "Call Time" reminders
 *     Google Chat     instant new-lead card
 *     Gmail           client acknowledgement + Gemini-drafted reply saved as a draft
 *   Status changes (from the Sheet or the AppSheet app) → processStatusChanges() →
 *     Google Docs     contract + invoice generated as PDFs into Drive
 *     Gmail           contract/invoice email, deposit receipt, thank-you
 *   Daily → dailyDigest(): follow-ups, stale-lead nudges, tomorrow's gigs.
 *
 * First run: open this project, run setup() once, approve permissions,
 * then Deploy → New deployment → Web app (Execute as: Me, Access: Anyone).
 * See docs/GOOGLE-WORKSPACE-SETUP.md for the full walkthrough.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BRAND = {
  artist: 'Aira Edward',
  management: 'Patty Tiu Management (PTM)',
  managementEmail: 'djae-dxb@pattytiu.com',
  artistEmail: 'djae.dxb@gmail.com',
  phone: '+971 55 512 6344',
  instagram: '@airaedward',
  site: 'https://bookings-djae.netlify.app',
  colors: { oxblood: '#7A1E1E', espresso: '#2B261E', cream: '#F2EDE6', ink: '#0A0A0A' },
}

// Live wiring. setup() seeds these into Script Properties, so it reuses them instead of creating new ones.
const CONFIG = {
  FORM_NAME: 'booking',                                            // Netlify form name (form[name="booking"])
  FORM_ID: '6aca9fdb33e9f700081cdab0',                             // Netlify form ID
  NETLIFY_SITE_ID: 'f04b4bd1-f542-4602-908f-c37020153829',         // bookings-djae.netlify.app
  SHEET_ID: '1wAQbIW4LcJ7TT0bwXpsJ35EnMKKVJJUXG83U-VgJLjE',        // bookings-djae · Ledger
  DOCS_FOLDER_ID: '16-NgLEYF_pLGQ6Sr9AC0SG6XD35d3thk',             // bookings-djae · Bookings
  CALENDAR_ID: 'djae-dxb@pattytiu.com',                            // bookings-djae calendar
  SHARE_WITH: ['djae-dxb@pattytiu.com', 'djae.dxb@gmail.com'],     // editors on the Sheet + folder
}

// 2026 rate card, AED per standard 4-hour block.
const RATES = {
  'Venue residency': 1500,
  'Corporate event': 2500,
  'Private party': 2500,
  'Wedding': 3000,
  'Christmas / festive brunch': 3000,
  "New Year's Eve": 10000,
  'Other': 2500,
}
const STANDARD_BLOCK_HOURS = 4
const DEPOSIT_RATE = 0.5
const FOLLOW_UP_AFTER_DAYS = 3

const STATUS = {
  NEW: 'New Lead',
  HOLD: 'On Hold',
  CONFIRMED: 'Confirmed',
  CONTRACT_SENT: 'Contract Sent',
  DEPOSIT_PAID: 'Deposit Paid',
  COMPLETED: 'Completed',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
}

const SHEET_NAME = 'Bookings'
const HEADERS = [
  'Booking ID', 'Received', 'Status', 'Client Name', 'Email', 'Phone', 'Company / Event',
  'Event Type', 'Event Date', 'Call Time', 'Set Start', 'Set End', 'Venue', 'Venue Address',
  'City', 'Guests', 'Budget', 'Vibe', 'Must Play', 'Do Not Play', 'Notes',
  'AI Summary', 'AI Fit Score', 'AI Vibe Tags', 'AI BPM Range', 'AI Energy Arc',
  'AI Suggested Tracks', 'AI Draft Reply', 'Quote (AED)', 'Deposit (AED)',
  'Calendar Event ID', 'Map Link', 'Contract PDF', 'Invoice PDF',
  'Last Processed Status', 'Last Client Email', 'Netlify Submission ID',
]

function props_() {
  return PropertiesService.getScriptProperties()
}
function prop_(key) {
  return props_().getProperty(key) || ''
}

// ---------------------------------------------------------------------------
// One-time setup
// ---------------------------------------------------------------------------

/** Creates the Sheet, gig calendar, Drive folder, contract & invoice templates, secret and triggers. */
function setup() {
  const p = props_()

  // Pin the live Sheet, folder and calendar from CONFIG.
  ;['SHEET_ID', 'DOCS_FOLDER_ID', 'CALENDAR_ID'].forEach((k) => {
    if (CONFIG[k]) p.setProperty(k, CONFIG[k])
  })

  if (!p.getProperty('WEBHOOK_SECRET')) {
    p.setProperty('WEBHOOK_SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''))
  }

  // Drive folder for generated documents
  let folder
  if (p.getProperty('DOCS_FOLDER_ID')) {
    folder = DriveApp.getFolderById(p.getProperty('DOCS_FOLDER_ID'))
  } else {
    folder = DriveApp.createFolder('Aira Edward — Bookings (PTM)')
    p.setProperty('DOCS_FOLDER_ID', folder.getId())
  }

  // Master spreadsheet
  let ss
  if (p.getProperty('SHEET_ID')) {
    ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'))
  } else {
    ss = SpreadsheetApp.create('Aira Edward — Booking Master')
    DriveApp.getFileById(ss.getId()).moveTo(folder)
    p.setProperty('SHEET_ID', ss.getId())
  }
  ensureSheet_(ss)

  // Dedicated gig calendar (keeps availability separate from personal events)
  if (!p.getProperty('CALENDAR_ID')) {
    const cal = CalendarApp.createCalendar('Aira Edward — Gigs', {
      timeZone: Session.getScriptTimeZone(),
      color: CalendarApp.Color.RED,
    })
    p.setProperty('CALENDAR_ID', cal.getId())
  }
  // Extra calendars whose events also block availability (comma-separated IDs), e.g. "primary"
  if (!p.getProperty('BLOCKING_CALENDAR_IDS')) p.setProperty('BLOCKING_CALENDAR_IDS', '')

  if (!p.getProperty('CONTRACT_TEMPLATE_ID')) {
    p.setProperty('CONTRACT_TEMPLATE_ID', createContractTemplate_(folder))
  }
  if (!p.getProperty('INVOICE_TEMPLATE_ID')) {
    p.setProperty('INVOICE_TEMPLATE_ID', createInvoiceTemplate_(folder))
  }
  if (!p.getProperty('CHAT_WEBHOOK_URL')) p.setProperty('CHAT_WEBHOOK_URL', '')
  if (!p.getProperty('NOTIFY_EMAIL')) p.setProperty('NOTIFY_EMAIL', BRAND.managementEmail)

  // Editors on the Sheet and the Docs folder (contracts + invoices inherit from the folder).
  CONFIG.SHARE_WITH.forEach((email) => {
    try { ss.addEditor(email); folder.addEditor(email) } catch (err) { Logger.log('Share failed for ' + email + ': ' + err) }
  })

  installTriggers_()

  Logger.log('Setup complete.')
  Logger.log('Sheet:            ' + ss.getUrl())
  Logger.log('Docs folder:      ' + folder.getUrl())
  Logger.log('Gig calendar ID:  ' + p.getProperty('CALENDAR_ID'))
  Logger.log('Netlify → Project configuration → Environment variables (functions scope):')
  Logger.log('  BOOKING_WEBHOOK_SECRET = ' + p.getProperty('WEBHOOK_SECRET'))
  Logger.log('  GOOGLE_APPS_SCRIPT_URL = ' + ScriptApp.getService().getUrl())
  Logger.log('Optional: paste a Google Chat space webhook URL into the CHAT_WEBHOOK_URL script property.')
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach((t) => {
    if (['processStatusChanges', 'dailyDigest'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t)
  })
  // AppSheet edits do not fire onEdit, so poll the Status column instead.
  ScriptApp.newTrigger('processStatusChanges').timeBased().everyMinutes(5).create()
  ScriptApp.newTrigger('dailyDigest').timeBased().everyDays(1).atHour(10).create()
}

function ensureSheet_(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME)
  if (!sheet) {
    sheet = ss.getSheets()[0]
    sheet.setName(SHEET_NAME)
  }
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground(BRAND.colors.oxblood).setFontColor(BRAND.colors.cream)
    sheet.setFrozenRows(1)
    sheet.setFrozenColumns(3)
  }
  // Keep dates, times and phone numbers as typed (stops "+971…" becoming a formula)
  ;['Phone', 'Event Date', 'Call Time', 'Set Start', 'Set End'].forEach((h) => {
    sheet.getRange(2, HEADERS.indexOf(h) + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@')
  })
  const statusCol = HEADERS.indexOf('Status') + 1
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(Object.keys(STATUS).map((k) => STATUS[k]), true).build()
  sheet.getRange(2, statusCol, sheet.getMaxRows() - 1, 1).setDataValidation(rule)
  return sheet
}

function sheet_() {
  return ensureSheet_(SpreadsheetApp.openById(prop_('SHEET_ID')))
}

// ---------------------------------------------------------------------------
// Web app endpoints
// ---------------------------------------------------------------------------

/** GET ?action=availability&month=YYYY-MM&secret=… → { ok, busy: ['YYYY-MM-DD', …] } */
function doGet(e) {
  const q = (e && e.parameter) || {}
  if (q.secret !== prop_('WEBHOOK_SECRET')) return json_({ ok: false, error: 'unauthorized' })
  if (q.action === 'availability') return json_({ ok: true, busy: busyDates_(q.month) })
  return json_({ ok: true, service: 'aira-edward-bookings' })
}

/** POST { secret, booking, ai, submissionId, createdAt } from the Netlify submission-created function. */
function doPost(e) {
  let body
  try {
    body = JSON.parse(e.postData.contents)
  } catch (err) {
    return json_({ ok: false, error: 'invalid json' })
  }
  if (body.secret !== prop_('WEBHOOK_SECRET')) return json_({ ok: false, error: 'unauthorized' })

  const lock = LockService.getScriptLock()
  lock.waitLock(20000)
  try {
    const result = recordBooking_(body.booking || {}, body.ai || null, body.submissionId || '')
    return json_({ ok: true, bookingId: result.id })
  } catch (err) {
    console.error(err)
    notifyChatText_('⚠️ Booking automation error: ' + err.message)
    return json_({ ok: false, error: String(err.message || err) })
  } finally {
    lock.releaseLock()
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON)
}

// ---------------------------------------------------------------------------
// New booking pipeline
// ---------------------------------------------------------------------------

function recordBooking_(b, ai, submissionId) {
  const sheet = sheet_()
  const col = columnIndex_(sheet)

  // Ignore Netlify retries of the same submission
  if (submissionId) {
    const ids = sheet.getRange(2, col['Netlify Submission ID'], Math.max(sheet.getLastRow() - 1, 1), 1).getValues()
    if (ids.some((r) => r[0] === submissionId)) return { id: 'duplicate' }
  }

  const id = 'AE-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyMMdd') + '-' +
    Math.random().toString(36).slice(2, 6).toUpperCase()
  const quote = quoteFor_(b.event_type, b.set_start, b.set_end)
  const address = [b.venue, b.venue_address, b.city].filter(String).join(', ')
  const mapLink = address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(address) : ''

  const record = {
    'Booking ID': id,
    'Received': new Date(),
    'Status': STATUS.NEW,
    'Client Name': b.name,
    'Email': b.email,
    'Phone': b.phone,
    'Company / Event': b.company,
    'Event Type': b.event_type,
    'Event Date': b.event_date,
    'Call Time': b.call_time,
    'Set Start': b.set_start,
    'Set End': b.set_end,
    'Venue': b.venue,
    'Venue Address': address,
    'City': b.city,
    'Guests': b.guests,
    'Budget': b.budget,
    'Vibe': b.vibe,
    'Must Play': b.must_play,
    'Do Not Play': b.do_not_play,
    'Notes': b.notes,
    'AI Summary': ai ? ai.summary : '',
    'AI Fit Score': ai ? ai.fitScore : '',
    'AI Vibe Tags': ai ? (ai.vibeTags || []).join(', ') : '',
    'AI BPM Range': ai ? ai.bpmRange : '',
    'AI Energy Arc': ai ? ai.energyArc : '',
    'AI Suggested Tracks': ai ? (ai.suggestedTracks || []).map((t) => t.artist + ' — ' + t.title).join('\n') : '',
    'AI Draft Reply': ai ? ai.draftReply : '',
    'Quote (AED)': quote.total,
    'Deposit (AED)': quote.deposit,
    'Map Link': mapLink,
    'Last Processed Status': STATUS.NEW,
    'Netlify Submission ID': submissionId,
  }

  // Calendar hold first so the event ID lands in the same row write
  try {
    record['Calendar Event ID'] = createHold_(record, b)
    record['Status'] = STATUS.HOLD
    record['Last Processed Status'] = STATUS.HOLD
  } catch (err) {
    console.error('Calendar hold failed', err)
  }

  const row = HEADERS.map((h) => (record[h] === undefined ? '' : record[h]))
  sheet.appendRow(row)

  notifyNewLead_(record, ai)
  sendAcknowledgement_(record)
  if (ai && ai.draftReply && b.email) createReplyDraft_(record, ai)

  return { id: id }
}

function quoteFor_(eventType, setStart, setEnd) {
  const base = RATES[eventType] || RATES.Other
  const hours = setHours_(setStart, setEnd)
  const extra = Math.max(0, hours - STANDARD_BLOCK_HOURS)
  const total = Math.round(base + extra * (base / STANDARD_BLOCK_HOURS))
  return { base: base, hours: hours, extraHours: extra, total: total, deposit: Math.round(total * DEPOSIT_RATE) }
}

function setHours_(start, end) {
  if (!start || !end) return STANDARD_BLOCK_HOURS
  const toMin = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1])
  let diff = toMin(end) - toMin(start)
  if (diff <= 0) diff += 24 * 60
  return Math.round((diff / 60) * 2) / 2
}

/** Parses "YYYY-MM-DD" + "HH:mm" in the script time zone (set to Asia/Dubai). */
function at_(date, time) {
  return Utilities.parseDate(date + ' ' + (time || '00:00'), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')
}

/** Event spans Call Time → Set End so the "Call Time" reminders fire before arrival. */
function eventWindow_(date, callTime, setStart, setEnd) {
  const start = at_(date, callTime || setStart)
  let end = at_(date, setEnd || setStart)
  if (end <= start) end = new Date(end.getTime() + 24 * 3600 * 1000)
  return { start: start, end: end }
}

function createHold_(record, b) {
  const cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'))
  const w = eventWindow_(b.event_date, b.call_time, b.set_start, b.set_end)
  const event = cal.createEvent(
    'HOLD · ' + record['Event Type'] + ' · ' + (record['Venue'] || record['Company / Event']),
    w.start,
    w.end,
    { location: record['Venue Address'], description: eventDescription_(record) },
  )
  event.setColor(CalendarApp.EventColor.YELLOW)
  event.removeAllReminders()
  event.addPopupReminder(24 * 60) // day before
  event.addPopupReminder(180) // leave-home window
  event.addPopupReminder(60) // Call Time in 1 hour
  return event.getId()
}

function eventDescription_(r) {
  return [
    'Booking ' + r['Booking ID'] + ' — ' + r['Status'],
    '',
    'CALL TIME: ' + (r['Call Time'] || '—') + '   SET: ' + r['Set Start'] + '–' + r['Set End'],
    'Client: ' + r['Client Name'] + ' · ' + r['Email'] + ' · ' + (r['Phone'] || ''),
    'Event: ' + r['Event Type'] + (r['Company / Event'] ? ' — ' + r['Company / Event'] : ''),
    'Guests: ' + (r['Guests'] || '—') + '   Quote: AED ' + r['Quote (AED)'],
    '',
    'Vibe: ' + (r['Vibe'] || '—'),
    'Must play: ' + (r['Must Play'] || '—'),
    'Do not play: ' + (r['Do Not Play'] || '—'),
    r['AI BPM Range'] ? 'Gemini BPM range: ' + r['AI BPM Range'] : '',
    r['AI Energy Arc'] ? 'Energy arc: ' + r['AI Energy Arc'] : '',
    '',
    'Map: ' + (r['Map Link'] || '—'),
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Availability (read by the Netlify /api/availability function)
// ---------------------------------------------------------------------------

function busyDates_(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return []
  const tz = Session.getScriptTimeZone()
  const start = at_(month + '-01', '00:00')
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1)
  const ids = [prop_('CALENDAR_ID')].concat(prop_('BLOCKING_CALENDAR_IDS').split(',')).map((s) => s.trim()).filter(String)

  const busy = {}
  ids.forEach((id) => {
    const cal = id === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id)
    if (!cal) return
    cal.getEvents(start, end).forEach((ev) => {
      if (/^(FREE|AVAILABLE)\b/i.test(ev.getTitle())) return
      // Mark each calendar day the event touches; late-night sets ending before 6am stay on the start date.
      const d = new Date(ev.getStartTime())
      const last = new Date(ev.getEndTime().getTime() - 6 * 3600 * 1000)
      do {
        busy[Utilities.formatDate(d, tz, 'yyyy-MM-dd')] = true
        d.setDate(d.getDate() + 1)
      } while (d <= last)
    })
  })
  return Object.keys(busy).filter((k) => k.indexOf(month) === 0).sort()
}

// ---------------------------------------------------------------------------
// Status changes (from the Sheet or the AppSheet mobile app)
// ---------------------------------------------------------------------------

function processStatusChanges() {
  const lock = LockService.getScriptLock()
  if (!lock.tryLock(10000)) return
  try {
    const sheet = sheet_()
    const col = columnIndex_(sheet)
    const last = sheet.getLastRow()
    if (last < 2) return
    const values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues()

    values.forEach((row, i) => {
      const r = rowToRecord_(row, col)
      const status = r['Status']
      if (!status || status === r['Last Processed Status']) return
      const rowNum = i + 2
      try {
        handleStatus_(sheet, col, rowNum, r)
      } catch (err) {
        console.error('Status handling failed for ' + r['Booking ID'], err)
        notifyChatText_('⚠️ Could not process ' + r['Booking ID'] + ' → ' + status + ': ' + err.message)
      }
    })
  } finally {
    lock.releaseLock()
  }
}

function handleStatus_(sheet, col, rowNum, r) {
  const set = (header, value) => sheet.getRange(rowNum, col[header]).setValue(value)
  const status = r['Status']

  switch (status) {
    case STATUS.CONFIRMED: {
      const docs = generateDocuments_(r)
      set('Contract PDF', docs.contract.getUrl())
      set('Invoice PDF', docs.invoice.getUrl())
      updateEvent_(r, 'CONFIRMED', CalendarApp.EventColor.RED, true)
      sendContractEmail_(r, docs)
      set('Status', STATUS.CONTRACT_SENT)
      set('Last Processed Status', STATUS.CONTRACT_SENT)
      set('Last Client Email', new Date())
      notifyChatText_('✅ *' + r['Booking ID'] + '* confirmed — contract & invoice sent to ' + r['Client Name'] + '.')
      return
    }
    case STATUS.DEPOSIT_PAID:
      updateEvent_(r, 'LOCKED', CalendarApp.EventColor.GREEN)
      sendClientEmail_(r, 'Deposit received — your date is locked',
        'Thank you — we have received your deposit, and ' + niceDate_(r['Event Date']) +
        ' is now locked in Aira\'s calendar. We\'ll be in touch the week of the event to confirm the run of show, ' +
        'technical setup (Pioneer CDJ-3000 / DJM-A9) and call time.')
      set('Last Client Email', new Date())
      notifyChatText_('💰 Deposit paid for *' + r['Booking ID'] + '* (' + r['Venue'] + ', ' + r['Event Date'] + ').')
      break
    case STATUS.COMPLETED:
      sendClientEmail_(r, 'Thank you for having Aira Edward',
        'Thank you for having Aira at ' + (r['Venue'] || 'your event') + '. It was a pleasure building the room with you. ' +
        'We\'d love to hear how the night landed — simply reply to this email. If a photo or clip made it onto your feed, tag ' +
        BRAND.instagram + '. We look forward to the next one.')
      set('Last Client Email', new Date())
      break
    case STATUS.DECLINED:
      deleteEvent_(r)
      sendClientEmail_(r, 'Regarding your booking request',
        'Thank you for thinking of Aira for ' + niceDate_(r['Event Date']) + '. Unfortunately we\'re unable to take this booking. ' +
        'We\'d be glad to look at alternative dates — just reply with a few options.')
      set('Last Client Email', new Date())
      break
    case STATUS.CANCELLED:
      deleteEvent_(r)
      notifyChatText_('❌ *' + r['Booking ID'] + '* cancelled — calendar released.')
      break
    case STATUS.HOLD:
      updateEvent_(r, 'HOLD', CalendarApp.EventColor.YELLOW)
      break
  }
  set('Last Processed Status', status)
}

function event_(r) {
  if (!r['Calendar Event ID']) return null
  const cal = CalendarApp.getCalendarById(prop_('CALENDAR_ID'))
  return cal ? cal.getEventById(r['Calendar Event ID']) : null
}

function updateEvent_(r, label, color, inviteClient) {
  const ev = event_(r)
  if (!ev) return
  ev.setTitle(label + ' · ' + r['Event Type'] + ' · ' + (r['Venue'] || r['Company / Event']))
  ev.setColor(color)
  r['Status'] = label
  ev.setDescription(eventDescription_(r))
  if (inviteClient && r['Email']) {
    try { ev.addGuest(r['Email']) } catch (err) { console.warn('Could not add guest', err) }
  }
}

function deleteEvent_(r) {
  const ev = event_(r)
  if (ev) ev.deleteEvent()
}

// ---------------------------------------------------------------------------
// Google Docs → PDF: contract & invoice
// ---------------------------------------------------------------------------

function generateDocuments_(r) {
  const folder = DriveApp.getFolderById(prop_('DOCS_FOLDER_ID'))
  const q = quoteFor_(r['Event Type'], r['Set Start'], r['Set End'])
  const tz = Session.getScriptTimeZone()
  const invoiceNo = 'INV-' + r['Booking ID'].replace('AE-', '')
  const values = {
    '{{BOOKING_ID}}': r['Booking ID'],
    '{{INVOICE_NO}}': invoiceNo,
    '{{ISSUE_DATE}}': Utilities.formatDate(new Date(), tz, 'd MMMM yyyy'),
    '{{DUE_DATE}}': Utilities.formatDate(new Date(Date.now() + 7 * 86400000), tz, 'd MMMM yyyy'),
    '{{CLIENT_NAME}}': r['Client Name'],
    '{{CLIENT_EMAIL}}': r['Email'],
    '{{CLIENT_PHONE}}': r['Phone'] || '—',
    '{{COMPANY}}': r['Company / Event'] || r['Client Name'],
    '{{EVENT_TYPE}}': r['Event Type'],
    '{{EVENT_DATE}}': niceDate_(r['Event Date']),
    '{{CALL_TIME}}': r['Call Time'] || '—',
    '{{SET_START}}': r['Set Start'],
    '{{SET_END}}': r['Set End'],
    '{{SET_HOURS}}': String(q.hours),
    '{{VENUE}}': r['Venue'],
    '{{VENUE_ADDRESS}}': r['Venue Address'] || r['Venue'],
    '{{BASE_FEE}}': fmt_(q.base),
    '{{EXTRA_HOURS}}': String(q.extraHours),
    '{{EXTRA_FEE}}': fmt_(q.total - q.base),
    '{{TOTAL}}': fmt_(q.total),
    '{{DEPOSIT}}': fmt_(q.deposit),
    '{{BALANCE}}': fmt_(q.total - q.deposit),
    '{{MANAGEMENT}}': BRAND.management,
    '{{MANAGEMENT_EMAIL}}': BRAND.managementEmail,
  }
  const contract = fillTemplate_(prop_('CONTRACT_TEMPLATE_ID'), 'Contract — ' + r['Booking ID'] + ' — ' + r['Client Name'], values, folder)
  const invoice = fillTemplate_(prop_('INVOICE_TEMPLATE_ID'), invoiceNo + ' — ' + r['Client Name'], values, folder)
  return { contract: contract, invoice: invoice }
}

function fillTemplate_(templateId, name, values, folder) {
  const copy = DriveApp.getFileById(templateId).makeCopy(name, folder)
  const doc = DocumentApp.openById(copy.getId())
  const body = doc.getBody()
  Object.keys(values).forEach((k) => body.replaceText(k.replace(/[{}]/g, '\\$&'), String(values[k] || '')))
  doc.saveAndClose()
  const pdf = folder.createFile(copy.getAs(MimeType.PDF)).setName(name + '.pdf')
  copy.setTrashed(true)
  return pdf
}

function styleHeading_(p) {
  p.editAsText().setFontFamily('Anton').setForegroundColor(BRAND.colors.oxblood)
  return p
}

function createContractTemplate_(folder) {
  const doc = DocumentApp.create('TEMPLATE — Aira Edward Performance Contract')
  const b = doc.getBody()
  b.setMarginTop(48).setMarginBottom(48)
  b.editAsText().setFontFamily('Lato').setFontSize(11)
  b.getParagraphs()[0].setText('PATTY TIU MANAGEMENT').editAsText().setFontSize(8).setForegroundColor('#888888').setBold(true)
  styleHeading_(b.appendParagraph('AIRA EDWARD — PERFORMANCE AGREEMENT').setHeading(DocumentApp.ParagraphHeading.TITLE))
  b.appendParagraph('Booking reference {{BOOKING_ID}} · Issued {{ISSUE_DATE}}')
  styleHeading_(b.appendParagraph('1. Parties').setHeading(DocumentApp.ParagraphHeading.HEADING2))
  b.appendParagraph('This agreement is made between {{MANAGEMENT}} on behalf of the artist Aira Edward ("Artist"), and {{COMPANY}}, represented by {{CLIENT_NAME}} ({{CLIENT_EMAIL}}, {{CLIENT_PHONE}}) ("Client").')
  styleHeading_(b.appendParagraph('2. Engagement').setHeading(DocumentApp.ParagraphHeading.HEADING2))
  b.appendListItem('Event: {{EVENT_TYPE}}')
  b.appendListItem('Date: {{EVENT_DATE}}')
  b.appendListItem('Venue: {{VENUE}} — {{VENUE_ADDRESS}}')
  b.appendListItem('Artist call time: {{CALL_TIME}}')
  b.appendListItem('Performance: {{SET_START}} – {{SET_END}} ({{SET_HOURS}} hours)')
  styleHeading_(b.appendParagraph('3. Fee & payment').setHeading(DocumentApp.ParagraphHeading.HEADING2))
  b.appendParagraph('Total performance fee: AED {{TOTAL}}. A non-refundable deposit of AED {{DEPOSIT}} is due by {{DUE_DATE}} to secure the date. The balance of AED {{BALANCE}} is due no later than the day of the event. Additional performance time requested on the night is billed pro-rata.')
  styleHeading_(b.appendParagraph('4. Technical rider').setHeading(DocumentApp.ParagraphHeading.HEADING2))
  b.appendParagraph('The Client will provide a Pioneer CDJ-3000 x2 (or more) and DJM-A9 mixer, booth monitor, stable table at elbow height, and power, all set up and sound-checked before call time.')
  styleHeading_(b.appendParagraph('5. Travel & hospitality').setHeading(DocumentApp.ParagraphHeading.HEADING2))
  b.appendParagraph('For events outside the UAE, the Client covers return flights, accommodation, local transport and per diems. For UAE events, parking or transport at the venue is provided.')
  styleHeading_(b.appendParagraph('6. Cancellation').setHeading(DocumentApp.ParagraphHeading.HEADING2))
  b.appendParagraph('Cancellation by the Client within 14 days of the event: 100% of the fee is payable. Earlier cancellation forfeits the deposit. Should the Artist be unable to perform due to illness or force majeure, Management will offer a suitable replacement or a full refund.')
  styleHeading_(b.appendParagraph('7. Media').setHeading(DocumentApp.ParagraphHeading.HEADING2))
  b.appendParagraph('The Client may photograph and film the performance for promotional use, crediting @airaedward. Commercial use beyond this requires written consent from Management.')
  b.appendParagraph('')
  b.appendParagraph('For the Artist: ______________________   {{MANAGEMENT}}')
  b.appendParagraph('For the Client: ______________________   {{CLIENT_NAME}}')
  b.appendParagraph('Questions: {{MANAGEMENT_EMAIL}}').editAsText().setFontSize(9)
  doc.saveAndClose()
  DriveApp.getFileById(doc.getId()).moveTo(folder)
  return doc.getId()
}

function createInvoiceTemplate_(folder) {
  const doc = DocumentApp.create('TEMPLATE — Aira Edward Invoice')
  const b = doc.getBody()
  b.setMarginTop(48).setMarginBottom(48)
  b.editAsText().setFontFamily('Lato').setFontSize(11)
  b.getParagraphs()[0].setText('PATTY TIU MANAGEMENT').editAsText().setFontSize(8).setForegroundColor('#888888').setBold(true)
  styleHeading_(b.appendParagraph('INVOICE {{INVOICE_NO}}').setHeading(DocumentApp.ParagraphHeading.TITLE))
  b.appendParagraph('Issued {{ISSUE_DATE}} · Deposit due {{DUE_DATE}} · Ref {{BOOKING_ID}}')
  b.appendParagraph('Bill to: {{COMPANY}} — {{CLIENT_NAME}} · {{CLIENT_EMAIL}}')
  b.appendParagraph('')
  const table = b.appendTable([
    ['Description', 'Amount (AED)'],
    ['Aira Edward — {{EVENT_TYPE}}, {{EVENT_DATE}} at {{VENUE}} (standard 4-hour block)', '{{BASE_FEE}}'],
    ['Additional performance time ({{EXTRA_HOURS}} hrs, pro-rata)', '{{EXTRA_FEE}}'],
    ['TOTAL', '{{TOTAL}}'],
    ['Deposit due now (50%)', '{{DEPOSIT}}'],
    ['Balance due on event day', '{{BALANCE}}'],
  ])
  table.getRow(0).editAsText().setBold(true).setForegroundColor(BRAND.colors.cream)
  for (let c = 0; c < 2; c++) table.getRow(0).getCell(c).setBackgroundColor(BRAND.colors.oxblood)
  table.getRow(3).editAsText().setBold(true)
  b.appendParagraph('')
  b.appendParagraph('Payment details are provided by {{MANAGEMENT}}. Please quote {{INVOICE_NO}} as the payment reference and send remittance to {{MANAGEMENT_EMAIL}}.')
  doc.saveAndClose()
  DriveApp.getFileById(doc.getId()).moveTo(folder)
  return doc.getId()
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

function emailHtml_(heading, paragraphs, r) {
  const c = BRAND.colors
  const ps = paragraphs.map((p) => '<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:' + c.cream + '">' + p + '</p>').join('')
  return '<div style="background:' + c.espresso + ';padding:32px;font-family:Helvetica,Arial,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto">' +
    '<p style="margin:0 0 24px;font-size:11px;letter-spacing:.15em;color:rgba(242,237,230,.6);font-weight:bold">PATTY TIU MANAGEMENT</p>' +
    '<div style="background:' + c.oxblood + ';padding:32px;border-radius:16px">' +
    '<h1 style="margin:0 0 20px;font-family:Impact,Anton,sans-serif;font-weight:normal;font-size:36px;letter-spacing:.02em;text-transform:uppercase;color:' + c.cream + '">' + heading + '</h1>' +
    ps +
    (r ? '<p style="margin:24px 0 0;font-size:13px;color:rgba(242,237,230,.72)">Ref ' + r['Booking ID'] + ' · ' + r['Event Type'] + ' · ' + niceDate_(r['Event Date']) + '</p>' : '') +
    '</div>' +
    '<p style="margin:24px 0 0;font-size:12px;color:rgba(242,237,230,.72)">Aira Edward — Open-format DJ, Dubai · ' + BRAND.managementEmail + ' · ' + BRAND.phone + ' · ' + BRAND.instagram + '</p>' +
    '</div></div>'
}

function sendAcknowledgement_(r) {
  if (!r['Email']) return
  const first = String(r['Client Name'] || '').split(' ')[0] || 'there'
  GmailApp.sendEmail(r['Email'], 'We\'ve received your booking request — Aira Edward', '', {
    name: 'Aira Edward (PTM)',
    replyTo: BRAND.managementEmail,
    htmlBody: emailHtml_('Request received', [
      'Hi ' + first + ',',
      'Thank you for your request for <b>' + r['Event Type'] + '</b> at <b>' + (r['Venue'] || 'your venue') + '</b> on <b>' +
        niceDate_(r['Event Date']) + '</b> (' + r['Set Start'] + '–' + r['Set End'] + '). The date is now on tentative hold while management reviews the details.',
      'You\'ll hear back personally within 24 hours with availability and next steps. Once confirmed, we\'ll send your performance contract and invoice.',
      '— Patty Tiu Management, on behalf of Aira Edward',
    ], r),
  })
}

/** Gemini's personalised reply is saved as a Gmail draft so Aira or PTM can review before sending. */
function createReplyDraft_(r, ai) {
  const tracks = (ai.suggestedTracks || []).map((t) => '  • ' + t.artist + ' — ' + t.title + (t.why ? ' (' + t.why + ')' : '')).join('\n')
  GmailApp.createDraft(r['Email'], 'Re: ' + r['Event Type'] + ' on ' + niceDate_(r['Event Date']) + ' — Aira Edward', ai.draftReply, {
    name: 'Aira Edward (PTM)',
    replyTo: BRAND.managementEmail,
  })
  // Internal set-prep notes for Aira (not sent to the client)
  if (tracks) {
    GmailApp.createDraft(prop_('NOTIFY_EMAIL') || Session.getActiveUser().getEmail(),
      '[Set prep] ' + r['Booking ID'] + ' · ' + r['Venue'],
      'Gemini set notes for ' + r['Booking ID'] + '\n\nFit score: ' + ai.fitScore + '/10\nBPM: ' + ai.bpmRange +
      '\nVibe: ' + (ai.vibeTags || []).join(', ') + '\n\nEnergy arc:\n' + ai.energyArc + '\n\nSuggested tracks:\n' + tracks)
  }
}

function sendContractEmail_(r, docs) {
  const q = quoteFor_(r['Event Type'], r['Set Start'], r['Set End'])
  GmailApp.sendEmail(r['Email'], 'Confirmed: Aira Edward — ' + niceDate_(r['Event Date']) + ' (contract & invoice)', '', {
    name: 'Aira Edward (PTM)',
    replyTo: BRAND.managementEmail,
    cc: BRAND.managementEmail,
    attachments: [docs.contract.getBlob(), docs.invoice.getBlob()],
    htmlBody: emailHtml_('Your date is confirmed', [
      'Hi ' + String(r['Client Name']).split(' ')[0] + ',',
      'Great news — Aira is confirmed for <b>' + r['Event Type'] + '</b> at <b>' + r['Venue'] + '</b> on <b>' + niceDate_(r['Event Date']) + '</b>.',
      'Attached are your performance agreement and invoice. To lock the date, please return the signed agreement and settle the deposit of <b>AED ' +
        fmt_(q.deposit) + '</b> within 7 days.',
      'Artist call time: <b>' + (r['Call Time'] || 'TBC') + '</b> · Set: <b>' + r['Set Start'] + '–' + r['Set End'] + '</b>. A calendar invite is on its way.',
    ], r),
  })
}

function sendClientEmail_(r, subject, message) {
  if (!r['Email']) return
  GmailApp.sendEmail(r['Email'], subject + ' — Aira Edward', '', {
    name: 'Aira Edward (PTM)',
    replyTo: BRAND.managementEmail,
    htmlBody: emailHtml_(subject, ['Hi ' + String(r['Client Name']).split(' ')[0] + ',', message, '— Patty Tiu Management, on behalf of Aira Edward'], r),
  })
}

// ---------------------------------------------------------------------------
// Google Chat
// ---------------------------------------------------------------------------

function postChat_(payload) {
  const url = prop_('CHAT_WEBHOOK_URL')
  if (!url) return
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  })
}

function notifyChatText_(text) {
  postChat_({ text: text })
}

function notifyNewLead_(r, ai) {
  const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + prop_('SHEET_ID')
  const widgets = [
    { decoratedText: { topLabel: 'When', text: niceDate_(r['Event Date']) + ' · Call ' + (r['Call Time'] || '—') + ' · Set ' + r['Set Start'] + '–' + r['Set End'] } },
    { decoratedText: { topLabel: 'Where', text: r['Venue'] + (r['City'] ? ', ' + r['City'] : '') } },
    { decoratedText: { topLabel: 'Client', text: r['Client Name'] + ' · ' + r['Email'] + (r['Phone'] ? ' · ' + r['Phone'] : '') } },
    { decoratedText: { topLabel: 'Budget / Quote', text: (r['Budget'] || '—') + ' / AED ' + fmt_(r['Quote (AED)']) } },
  ]
  if (ai) {
    widgets.push({ decoratedText: { topLabel: 'Gemini · fit ' + ai.fitScore + '/10', text: ai.summary, wrapText: true } })
    widgets.push({ decoratedText: { topLabel: 'Vibe', text: (ai.vibeTags || []).join(' · ') + ' · ' + (ai.bpmRange || ''), wrapText: true } })
  }
  const buttons = [{ text: 'Open Sheet', onClick: { openLink: { url: sheetUrl } } }]
  if (r['Map Link']) buttons.push({ text: 'Map', onClick: { openLink: { url: r['Map Link'] } } })
  if (r['Phone']) buttons.push({ text: 'WhatsApp', onClick: { openLink: { url: 'https://wa.me/' + String(r['Phone']).replace(/\D/g, '') } } })
  widgets.push({ buttonList: { buttons: buttons } })

  postChat_({
    text: '🎧 New booking lead: ' + r['Event Type'] + ' · ' + r['Event Date'],
    cardsV2: [{
      cardId: r['Booking ID'],
      card: {
        header: { title: 'New lead · ' + r['Event Type'], subtitle: r['Booking ID'] + ' · now ON HOLD in calendar' },
        sections: [{ widgets: widgets }],
      },
    }],
  })
}

// ---------------------------------------------------------------------------
// Daily digest: follow-ups & tomorrow's gigs
// ---------------------------------------------------------------------------

function dailyDigest() {
  const sheet = sheet_()
  const col = columnIndex_(sheet)
  const last = sheet.getLastRow()
  if (last < 2) return
  const values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues()
  const tz = Session.getScriptTimeZone()
  const now = new Date()
  const tomorrow = Utilities.formatDate(new Date(now.getTime() + 86400000), tz, 'yyyy-MM-dd')
  const ageDays = (d) => (d instanceof Date ? (now - d) / 86400000 : 0)
  const lines = []

  values.forEach((row, i) => {
    const r = rowToRecord_(row, col)
    const date = normaliseDate_(r['Event Date'])

    if ((r['Status'] === STATUS.NEW || r['Status'] === STATUS.HOLD) && ageDays(r['Received']) >= 1) {
      lines.push('⏳ Unanswered lead ' + r['Booking ID'] + ' — ' + r['Client Name'] + ' (' + r['Event Type'] + ', ' + date + ')')
    }

    if (r['Status'] === STATUS.CONTRACT_SENT && ageDays(r['Last Client Email']) >= FOLLOW_UP_AFTER_DAYS) {
      sendClientEmail_(r, 'Friendly reminder: securing your date',
        'Just a quick follow-up on the contract and invoice for ' + niceDate_(date) + '. The date stays on hold for a short time only — ' +
        'once the signed agreement and deposit are in, it\'s locked. Reply here with any questions.')
      sheet.getRange(i + 2, col['Last Client Email']).setValue(now)
      lines.push('📨 Sent deposit follow-up to ' + r['Client Name'] + ' (' + r['Booking ID'] + ')')
    }

    if (date === tomorrow && [STATUS.CONTRACT_SENT, STATUS.DEPOSIT_PAID, STATUS.CONFIRMED].indexOf(r['Status']) !== -1) {
      lines.push('🎛️ TOMORROW: ' + r['Venue'] + ' · call ' + (r['Call Time'] || '—') + ' · set ' + r['Set Start'] + '–' + r['Set End'] +
        (r['Map Link'] ? ' · ' + r['Map Link'] : ''))
    }
  })

  if (lines.length) notifyChatText_('*Daily booking digest*\n' + lines.join('\n'))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function columnIndex_(sheet) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
  const map = {}
  headers.forEach((h, i) => { map[h] = i + 1 })
  HEADERS.forEach((h) => { if (!map[h]) throw new Error('Missing column "' + h + '" in ' + SHEET_NAME) })
  return map
}

function rowToRecord_(row, col) {
  const r = {}
  Object.keys(col).forEach((h) => { r[h] = row[col[h] - 1] })
  // Sheets may auto-convert text dates/times; normalise back to strings
  r['Event Date'] = normaliseDate_(r['Event Date'])
  ;['Call Time', 'Set Start', 'Set End'].forEach((h) => {
    if (r[h] instanceof Date) r[h] = Utilities.formatDate(r[h], Session.getScriptTimeZone(), 'HH:mm')
  })
  return r
}

function normaliseDate_(v) {
  return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v || '')
}

function niceDate_(ymd) {
  if (!ymd) return 'TBC'
  return Utilities.formatDate(at_(normaliseDate_(ymd), '12:00'), Session.getScriptTimeZone(), 'EEEE d MMMM yyyy')
}

function fmt_(n) {
  return Number(n || 0).toLocaleString('en-US')
}

/** Manual test: run from the editor to push a sample booking through the whole pipeline. */
function testBooking() {
  const d = new Date(Date.now() + 21 * 86400000)
  recordBooking_({
    name: 'Test Client', email: Session.getActiveUser().getEmail(), phone: '+971500000000', company: 'Pipeline test',
    event_type: 'Corporate event', guests: '120', event_date: Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    call_time: '19:30', set_start: '20:30', set_end: '00:30', venue: 'Cielo Sky Lounge', venue_address: 'Park Hyatt Dubai',
    city: 'Dubai', budget: '2,500 – 5,000', vibe: 'House / Nu Disco', must_play: 'Purple Disco Machine', do_not_play: '', notes: 'Test',
  }, null, '')
}
