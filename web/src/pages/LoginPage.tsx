import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { BrandMark } from '@/components/BrandMark'
import { ErrorNote, Field } from '@/components/parts'
import { ThemeToggle } from '@/components/ThemeToggle'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthStore } from '@/stores/authStore'

// The frame the two pre-dashboard screens share.
function AuthFrame({
  title,
  intro,
  footnote,
  children,
}: {
  title: string
  intro: string
  footnote?: string
  children: React.ReactNode
}) {
  return (
    <main className="relative grid min-h-screen place-items-center bg-shell px-4">
      <ThemeToggle className="absolute right-4 top-4" />
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold tracking-tight">
          <BrandMark className="size-6" />
          postgres2mcp
        </div>
        <div className="space-y-4 rounded-xl border border-border bg-card p-6 shadow-[0_1px_2px_rgba(22,28,45,0.05),0_12px_32px_-22px_rgba(22,28,45,0.30)]">
          <div className="space-y-1">
            <h1 className="text-[0.9375rem] font-semibold">{title}</h1>
            <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{intro}</p>
          </div>
          {children}
        </div>
        {footnote ? (
          <p className="mt-4 text-balance text-center text-xs leading-relaxed text-muted-foreground">{footnote}</p>
        ) : null}
      </div>
    </main>
  )
}

export function LoginPage() {
  const login = useAuthStore((s) => s.login)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(await login(username.trim(), password))
    setBusy(false)
  }

  return (
    <AuthFrame title="Sign in" intro="With the admin account of this server.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Username">
          <Input
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            className="h-9"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
              setError(null)
            }}
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            autoComplete="current-password"
            className="h-9"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              setError(null)
            }}
          />
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button type="submit" size="lg" className="w-full" disabled={busy || username.trim() === '' || password === ''}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Sign in
        </Button>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Locked out? Whoever can open a shell on the server can set a new password there:{' '}
          <code className="font-mono">postgres2mcp reset-password &lt;username&gt;</code>
        </p>
      </form>
    </AuthFrame>
  )
}

// First run: nobody has an account yet, so whoever is here creates the admin.
export function SetupPage() {
  const setup = useAuthStore((s) => s.setup)
  const codeRequired = useAuthStore((s) => s.setupCodeRequired)
  const linkCode = useAuthStore((s) => s.setupCode)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [code, setCode] = useState('')
  // The code that came with the link was refused, so ask for it by hand.
  const [linkCodeRefused, setLinkCodeRefused] = useState(false)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Complaints wait until a field has been left, or could not become right by typing on.
  const [passwordLeft, setPasswordLeft] = useState(false)
  const [repeatLeft, setRepeatLeft] = useState(false)

  const tooShort = passwordLeft && password !== '' && password.length < 8
  const mismatch = repeat !== '' && repeat !== password && (repeatLeft || repeat.length >= password.length)
  // A setup link carries the code; without one (or with a stale one) it is typed in.
  const askForCode = codeRequired && (linkCode === null || linkCodeRefused)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    const failure = await setup(username.trim(), password, askForCode ? code.trim() : (linkCode ?? undefined))
    setBusy(false)
    if (failure === null) return
    // A refused code is reported at the code field, which appears if the link carried the code.
    if (failure.codeRefused) {
      setLinkCodeRefused(true)
      setCodeError(
        askForCode && code.trim() !== ''
          ? 'That is not this server’s setup code.'
          : 'The setup link is not for this server, or is out of date. Enter the current code.'
      )
    } else {
      setError(failure.message)
    }
  }

  return (
    <AuthFrame
      title="Create the admin account"
      intro="postgres2mcp is running and has no account yet. Create the one you will sign in with."
      footnote="Next, the dashboard walks you through connecting your first MCP client. About two minutes."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {askForCode ? (
          <div className="space-y-1.5">
            <Field label="Setup code">
              <Input
                autoFocus
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={codeError !== null || undefined}
                className="h-9 font-mono"
                value={code}
                onChange={(e) => {
                  setCode(e.target.value)
                  setCodeError(null)
                }}
              />
            </Field>
            {/* The complaint sits against the field; where to find the code follows it. */}
            {codeError ? <ErrorNote>{codeError}</ErrorNote> : null}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Proves you are the one who started this server. It is the end of the setup link (…/?setup=CODE) that the
              installer printed, and that the server prints in its log each time it starts.
            </p>
          </div>
        ) : null}
        <Field label="Username">
          <Input
            autoFocus={!askForCode}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            className="h-9"
            placeholder="admin"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
              setError(null)
            }}
          />
        </Field>
        <Field label="Password" help={tooShort ? undefined : 'At least 8 characters.'}>
          <Input
            type="password"
            autoComplete="new-password"
            aria-invalid={tooShort || undefined}
            className="h-9"
            value={password}
            onBlur={() => setPasswordLeft(true)}
            onChange={(e) => {
              setPassword(e.target.value)
              setError(null)
            }}
          />
        </Field>
        {tooShort ? <ErrorNote>The password needs at least 8 characters.</ErrorNote> : null}
        <Field label="Repeat password">
          <Input
            type="password"
            autoComplete="new-password"
            aria-invalid={mismatch || undefined}
            className="h-9"
            value={repeat}
            onBlur={() => setRepeatLeft(true)}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>
        {mismatch ? <ErrorNote>The two passwords do not match.</ErrorNote> : null}
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button
          type="submit"
          size="lg"
          className="w-full"
          disabled={
            busy ||
            username.trim() === '' ||
            password.length < 8 ||
            repeat !== password ||
            (askForCode && code.trim() === '')
          }
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Create account
        </Button>
      </form>
    </AuthFrame>
  )
}
