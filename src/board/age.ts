const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60]
]

export function ageText(at: number, now: number, locale: string): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000))
  const [unit, size] = UNITS.find(([, size]) => seconds >= size) ?? ['second', 1]
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.floor(seconds / size), unit)
}
