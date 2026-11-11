import { Suspense } from "react";
import { login } from "../actions";

export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return (
    <Suspense fallback={null}>
      <LoginForm searchParams={searchParams} />
    </Suspense>
  );
}

async function LoginForm({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <form action={login} className="mx-auto mt-20 flex max-w-xs flex-col gap-3 text-sm">
      <h1 className="text-lg font-semibold">Dashboard password</h1>
      <input type="hidden" name="next" value={sp.next ?? "/"} />
      <input type="password" name="password" autoFocus required />
      {sp.error && <p className="text-red-700">Wrong password.</p>}
      <button className="rounded bg-zinc-900 px-3 py-1.5 font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">Sign in</button>
    </form>
  );
}
