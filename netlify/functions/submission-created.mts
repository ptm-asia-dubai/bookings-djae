// Netlify Forms event function: fires on every verified submission.
// Forwards the "booking" form to the Apps Script web app as { secret, booking, ai, submissionId, createdAt }.
const FORM_NAME = 'booking'

const FIELDS = [
  'name', 'email', 'phone', 'company', 'event_type', 'event_date', 'call_time', 'set_start', 'set_end',
  'venue', 'venue_address', 'city', 'guests', 'budget', 'vibe', 'must_play', 'do_not_play', 'notes',
] as const

const clean = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v)).trim()

export default async (req: Request) => {
  const scriptUrl = Netlify.env.get('GOOGLE_APPS_SCRIPT_URL')
  const secret = Netlify.env.get('BOOKING_WEBHOOK_SECRET')
  if (!scriptUrl || !secret) {
    console.error('Missing GOOGLE_APPS_SCRIPT_URL or BOOKING_WEBHOOK_SECRET')
    return new Response('not configured', { status: 500 })
  }

  try {
    const { payload } = (await req.json()) as {
      payload: { id: string; form_name: string; created_at: string; data: Record<string, unknown> }
    }
    if (payload.form_name !== FORM_NAME) return new Response('ignored', { status: 200 })

    const data = payload.data ?? {}
    if (clean(data['bot-field'])) return new Response('honeypot', { status: 200 })

    const booking = Object.fromEntries(FIELDS.map((f) => [f, clean(data[f])]))

    const res = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'follow',
      body: JSON.stringify({ secret, booking, ai: null, submissionId: payload.id, createdAt: payload.created_at }),
      signal: AbortSignal.timeout(25000),
    })
    const result = await res.text()
    console.log('Apps Script:', result)
    return new Response(result, { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('Forward to Apps Script failed:', err)
    return new Response(String(err), { status: 500 })
  }
}
