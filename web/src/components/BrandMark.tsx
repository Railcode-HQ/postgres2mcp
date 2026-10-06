// A database cylinder with a signal leaving it: a database, made callable.
// `signal` draws the arrow once, for the moment a call actually leaves.
export function BrandMark({ className, signal = false }: { className?: string; signal?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <ellipse cx="10" cy="6.5" rx="6.5" ry="2.75" className="stroke-blue-600 dark:stroke-blue-400" strokeWidth="1.75" />
      <path
        d="M3.5 6.5v11c0 1.52 2.91 2.75 6.5 2.75 1.1 0 2.13-.12 3.04-.32M3.5 12c0 1.52 2.91 2.75 6.5 2.75.6 0 1.18-.03 1.73-.1M16.5 6.5v4"
        className="stroke-blue-600 dark:stroke-blue-400"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M15 17.25h6m0 0-2.25-2.25M21 17.25 18.75 19.5"
        pathLength={1}
        className={signal ? 'p2m-signal stroke-foreground' : 'stroke-foreground'}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
