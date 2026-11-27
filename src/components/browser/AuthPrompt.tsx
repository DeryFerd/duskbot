import { LockKeyhole } from "../../icons";
import type { FormEvent } from "react";

import { t } from "@/lib/i18n";
import { rowButtonCls, rowPrimaryCls } from "../ui/GrokDialog";

/**
 * A site's HTTP sign-in (basic or digest), which a page cannot draw itself. Security: the password goes only to that
 * site's challenge; the fields are uncontrolled and cleared once sent, so it is never kept in state.
 */
export function AuthPrompt({ origin, realm, onAnswer }: {
  origin: string;
  realm: string;
  onAnswer: (answer: { username: string; password: string } | null) => void;
}) {
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const username = form.elements.namedItem("username") as HTMLInputElement;
    const password = form.elements.namedItem("password") as HTMLInputElement;
    onAnswer({ username: username.value, password: password.value });
    username.value = "";
    password.value = "";
  };
  return (
    <form role="dialog" aria-label={t("browser.auth.title")} onSubmit={submit} className="absolute inset-x-3 top-3 z-20 mx-auto flex max-w-sm flex-col gap-2 rounded-[14px] bg-app p-5 text-ink shadow-xl">
      <div className="flex items-center gap-2 pl-2.5 text-[15px] font-medium leading-[22px] tracking-[-0.006em]"><LockKeyhole size={14} aria-hidden="true" />{t("accounts.signIn")}</div>
      <p className="m-0 break-words pl-2.5 text-[13px] leading-[18px] text-ink-secondary">{realm ? t("browser.auth.realm", { origin, realm }) : origin}</p>
      <input name="username" aria-label={t("browser.auth.username")} autoComplete="off" spellCheck={false} maxLength={1024} placeholder={t("browser.auth.username")} className="h-8 rounded-lg bg-ink/[0.05] px-3 text-[13px] text-ink outline-none transition-[background-color] duration-[120ms] placeholder:text-ink/40 focus:bg-ink/[0.08]" />
      <input name="password" type="password" aria-label={t("logins.password")} autoComplete="new-password" maxLength={1024} placeholder={t("logins.password")} className="h-8 rounded-lg bg-ink/[0.05] px-3 text-[13px] text-ink outline-none transition-[background-color] duration-[120ms] placeholder:text-ink/40 focus:bg-ink/[0.08]" />
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={() => onAnswer(null)} className={rowButtonCls}>{t("common.cancel")}</button>
        <button type="submit" className={rowPrimaryCls}>{t("accounts.signIn")}</button>
      </div>
    </form>
  );
}
