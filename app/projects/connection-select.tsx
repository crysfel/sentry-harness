export type SentryConnectionOption = { name: string; configured: boolean };

/** Picks which Sentry login (SENTRY_AUTH_TOKEN[_<NAME>] in .env) a project uses. */
export function SentryConnectionSelect({ options, value }: { options: SentryConnectionOption[]; value?: string }) {
  const names = options.map((o) => o.name);
  const current = value ?? "default";
  // Keep a project's saved value visible even if its token was removed from .env.
  const all = names.includes(current) ? options : [...options, { name: current, configured: false }];
  return (
    <label className="flex flex-col gap-1">
      <span>Sentry connection</span>
      <select name="sentryConnection" defaultValue={current}>
        {all.map((o) => (
          <option key={o.name} value={o.name}>
            {o.name}
            {o.configured ? "" : " (no token)"}
          </option>
        ))}
      </select>
      <span className="text-xs text-zinc-500">
        The Sentry account to read from. <code>default</code> uses SENTRY_AUTH_TOKEN; <code>acme</code> uses SENTRY_AUTH_TOKEN_ACME in .env.
      </span>
    </label>
  );
}
