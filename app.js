// Aira Edward booking page: live availability calendar + Netlify Forms AJAX submit.

const form = document.querySelector('form[name="booking"]')
const dateInput = form.elements.event_date
const success = document.querySelector('.success')
const errorBox = form.querySelector('.form__error')

/* ---------------- Availability calendar ---------------- */

const cal = {
  grid: document.querySelector('.cal__grid'),
  title: document.querySelector('.cal__title'),
  status: document.querySelector('[data-cal-status]'),
  prev: document.querySelector('[data-cal="prev"]'),
  next: document.querySelector('[data-cal="next"]'),
  busy: new Set(),
  loaded: new Set(), // months already fetched, "YYYY-MM"
  live: null, // true when the Google Calendar feed answered
}

const today = new Date()
today.setHours(0, 0, 0, 0)
const MAX_MONTHS_AHEAD = 18
let view = new Date(today.getFullYear(), today.getMonth(), 1)

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

dateInput.min = iso(today)

async function loadMonth(d) {
  const key = monthKey(d)
  if (cal.loaded.has(key)) return
  cal.loaded.add(key)
  try {
    const res = await fetch(`/api/availability?month=${key}`)
    const data = await res.json()
    cal.live = Boolean(data.live)
    for (const day of data.busy || []) cal.busy.add(day)
  } catch {
    cal.live = false
  }
  updateStatus()
}

function updateStatus() {
  if (cal.live === null) return
  cal.status.textContent = cal.live
    ? 'Live from Aira’s calendar · updated every few minutes'
    : 'All dates subject to confirmation by management'
}

function render() {
  const year = view.getFullYear()
  const month = view.getMonth()
  cal.title.textContent = view.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7 // Monday-first
  const days = new Date(year, month + 1, 0).getDate()
  const picked = dateInput.value

  const cells = []
  for (let i = 0; i < offset; i++) cells.push('<span></span>')
  for (let d = 1; d <= days; d++) {
    const date = new Date(year, month, d)
    const key = iso(date)
    const past = date < today
    const busy = cal.busy.has(key)
    const label = date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    cells.push(
      `<button type="button" class="cal__day" data-date="${key}"` +
        `${past || busy ? ' disabled' : ''}${busy ? ' data-busy' : ''}` +
        `${key === iso(today) ? ' data-today' : ''}` +
        ` aria-pressed="${key === picked}" aria-label="${label}${busy ? ', unavailable' : ''}">${d}</button>`,
    )
  }
  cal.grid.innerHTML = cells.join('')

  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1)
  const last = new Date(today.getFullYear(), today.getMonth() + MAX_MONTHS_AHEAD, 1)
  cal.prev.disabled = view <= thisMonth
  cal.next.disabled = view >= last
}

async function show(d) {
  view = new Date(d.getFullYear(), d.getMonth(), 1)
  render()
  await loadMonth(view)
  render()
}

cal.prev.addEventListener('click', () => show(new Date(view.getFullYear(), view.getMonth() - 1, 1)))
cal.next.addEventListener('click', () => show(new Date(view.getFullYear(), view.getMonth() + 1, 1)))

cal.grid.addEventListener('click', (e) => {
  const btn = e.target.closest('.cal__day')
  if (!btn || btn.disabled) return
  dateInput.value = btn.dataset.date
  dateInput.removeAttribute('aria-invalid')
  render()
  dateInput.closest('fieldset').scrollIntoView({ behavior: 'smooth', block: 'center' })
})

dateInput.addEventListener('change', async () => {
  if (!dateInput.value) return render()
  const [y, m] = dateInput.value.split('-').map(Number)
  await show(new Date(y, m - 1, 1))
  checkBusy()
})

function checkBusy() {
  if (cal.busy.has(dateInput.value)) {
    showError('That date is already booked or on hold — please choose another, or mention flexibility in your notes.')
    dateInput.setAttribute('aria-invalid', 'true')
    return true
  }
  return false
}

show(view)

/* ---------------- Form submission ---------------- */

function showError(msg) {
  errorBox.textContent = msg
  errorBox.hidden = false
}

function validate() {
  errorBox.hidden = true
  let firstBad = null
  for (const el of form.querySelectorAll('[required]')) {
    const ok = el.type === 'checkbox' ? el.checked : el.checkValidity() && el.value.trim() !== ''
    if (ok) el.removeAttribute('aria-invalid')
    else el.setAttribute('aria-invalid', 'true')
    if (!ok && !firstBad) firstBad = el
  }
  if (firstBad) {
    showError('Please complete the highlighted fields.')
    firstBad.focus()
    return false
  }
  if (dateInput.value < iso(today)) {
    showError('Please choose a date in the future.')
    dateInput.focus()
    return false
  }
  return !checkBusy()
}

function encode(fd) {
  const params = new URLSearchParams()
  const vibes = fd.getAll('vibe')
  for (const [k, v] of fd.entries()) if (k !== 'vibe') params.append(k, v)
  params.append('vibe', vibes.join(', '))
  return params.toString()
}

// Google Calendar "add event" link so the client can hold the date on their own calendar.
function clientCalendarLink(data) {
  const ymd = data.event_date.replaceAll('-', '')
  const start = (data.set_start || '21:00').replace(':', '')
  const end = (data.set_end || '01:00').replace(':', '')
  let endDate = ymd
  if (end <= start) {
    const d = new Date(`${data.event_date}T00:00:00`)
    d.setDate(d.getDate() + 1)
    endDate = iso(d).replaceAll('-', '')
  }
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `HOLD: Aira Edward — ${data.event_type}`,
    dates: `${ymd}T${start}00/${endDate}T${end}00`,
    ctz: 'Asia/Dubai',
    details: 'Tentative — pending confirmation from Patty Tiu Management (djae-dxb@pattytiu.com).',
    location: [data.venue, data.venue_address, data.city].filter(Boolean).join(', '),
  })
  return `https://calendar.google.com/calendar/render?${params}`
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  if (!validate()) return

  const button = form.querySelector('button[type="submit"]')
  button.disabled = true
  button.textContent = 'Sending…'

  const fd = new FormData(form)
  try {
    const res = await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: encode(fd),
    })
    if (!res.ok) throw new Error(`Status ${res.status}`)

    const data = Object.fromEntries(fd.entries())
    const nice = new Date(`${data.event_date}T00:00:00`).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    })
    success.querySelector('[data-success-summary]').textContent =
      `${data.event_type} at ${data.venue} on ${nice}, ${data.set_start}–${data.set_end}. Thank you, ${data.name.split(' ')[0]}.`
    success.querySelector('[data-success-cal]').href = clientCalendarLink(data)

    cal.busy.add(data.event_date)
    form.hidden = true
    success.hidden = false
    success.focus()
    success.scrollIntoView({ behavior: 'smooth', block: 'center' })
  } catch {
    showError('Something went wrong sending your request. Please try again or email djae-dxb@pattytiu.com.')
  } finally {
    button.disabled = false
    button.textContent = 'Send booking request'
  }
})

success.querySelector('[data-success-reset]').addEventListener('click', () => {
  form.reset()
  render()
  success.hidden = true
  form.hidden = false
  form.scrollIntoView({ behavior: 'smooth', block: 'start' })
})

form.addEventListener('input', (e) => {
  if (e.target.hasAttribute('aria-invalid')) e.target.removeAttribute('aria-invalid')
})
