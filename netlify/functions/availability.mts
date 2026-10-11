// Busy days for the booking calendar. Primary source is the Apps Script web app
// (doGet?action=availability, reading the gig calendar + BLOCKING_CALENDAR_IDS) via
// GOOGLE_APPS_SCRIPT_URL + BOOKING_WEBHOOK_SECRET. Fallback is a private iCal feed in
// AVAILABILITY_ICS_URL. With neither, the page shows "All dates subject to confirmation".

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

// DTSTART;VALUE=DATE:20261012  |  DTSTART:20261012T190000Z  |  DTSTART;TZID=Asia/Dubai:20261012T190000
function parseDate(line: string) {
  const value = line.slice(line.lastIndexOf(':') + 1).trim()
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null
  const [, y, mo, d, h] = m
  return { date: new Date(Date.UTC(+y, +mo - 1, +d)), allDay: !h }
}

function busyDays(ics: string, from: Date, to: Date) {
  const days = new Set<string>()
  const unfolded = ics.replace(/\r?\n[ \t]/g, '')
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const lines = block.split(/\r?\n/)
    if (lines.some((l) => /^STATUS:CANCELLED/i.test(l)) || lines.some((l) => /^TRANSP:TRANSPARENT/i.test(l))) continue
    const startLine = lines.find((l) => l.startsWith('DTSTART'))
    const endLine = lines.find((l) => l.startsWith('DTEND'))
    const start = startLine && parseDate(startLine)
    if (!start) continue
    const end = endLine ? parseDate(endLine) : null
    // All-day DTEND is exclusive; a timed set ending after midnight still only blocks its start day.
    const last = end && end.allDay ? new Date(end.date.getTime() - 86400000) : start.date
    for (let d = new Date(start.date); d <= last; d = new Date(d.getTime() + 86400000)) {
      if (d >= from && d < to) days.add(ymd(d))
    }
  }
  return [...days].sort()
}

export default async (req: Request) => {
  const month = new URL(req.url).searchParams.get('month') ?? ''
  const m = month.match(/^(\d{4})-(\d{2})$/)
  if (!m) return Response.json({ error: 'month must be YYYY-MM' }, { status: 400 })

  const from = new Date(Date.UTC(+m[1], +m[2] - 1, 1))
  const to = new Date(Date.UTC(+m[1], +m[2], 1))
  const scriptUrl = Netlify.env.get('GOOGLE_APPS_SCRIPT_URL')
  const secret = Netlify.env.get('BOOKING_WEBHOOK_SECRET')
  const feed = Netlify.env.get('AVAILABILITY_ICS_URL')
  if (!(scriptUrl && secret) && !feed) return Response.json({ live: false, busy: [] })

  try {
    let busy: string[]
    if (scriptUrl && secret) {
      const url = new URL(scriptUrl)
      url.search = new URLSearchParams({ action: 'availability', month, secret }).toString()
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) })
      const body = (await res.json()) as { ok: boolean; busy?: string[]; error?: string }
      if (!body.ok) throw new Error(`Apps Script: ${body.error ?? 'error'}`)
      busy = body.busy ?? []
    } else {
      const res = await fetch(feed!)
      if (!res.ok) throw new Error(`Feed responded ${res.status}`)
      busy = busyDays(await res.text(), from, to)
    }
    return Response.json(
      { live: true, busy },
      { headers: { 'Cache-Control': 'public, max-age=0, must-revalidate', 'Netlify-CDN-Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    )
  } catch (err) {
    console.error('availability feed failed', err)
    return Response.json({ live: false, busy: [] })
  }
}

export const config = { path: '/api/availability' }
