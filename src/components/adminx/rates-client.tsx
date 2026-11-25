"use client";

import { useEffect, useRef } from "react";
import { adminAddCreatorAction } from "@/lib/rates-actions";
import { Status, Submit, useForm } from "@/components/client";
import { Field, cx, inputClass } from "@/components/ui";

const NICHES = ["general", "pop-culture", "wellness", "comedy", "entertainment", "lifestyle", "beauty", "fashion", "tech", "fitness", "food", "travel", "finance", "gaming", "news", "publisher", "other"];

/** Admin: add a creator from just a link. Everything else is optional. */
export function AddCreatorForm() {
  const { state, pending, onSubmit } = useForm(adminAddCreatorAction, { refresh: true });
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} onSubmit={onSubmit} noValidate className="space-y-4">
      <Field label="Link" htmlFor="rc-link" hint="Their Instagram, TikTok, X, YouTube or website. The name and handle come from it.">
        <input id="rc-link" name="link" inputMode="url" placeholder="https://instagram.com/bimboademoye" className={inputClass} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Name" htmlFor="rc-name" optional>
          <input id="rc-name" name="name" className={inputClass} />
        </Field>
        <Field label="Niche" htmlFor="rc-niche">
          <select id="rc-niche" name="niche" className={inputClass} defaultValue="general">
            {NICHES.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </Field>
        <Field label="Type" htmlFor="rc-type">
          <select id="rc-type" name="type" className={inputClass} defaultValue="creator">
            <option value="creator">Creator</option>
            <option value="media">Media house</option>
          </select>
        </Field>
        <Field label="Followers" htmlFor="rc-followers" optional>
          <input id="rc-followers" name="followers" inputMode="numeric" className={inputClass} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
        <Field label="Rates" htmlFor="rc-rates" optional hint='One per line: "Reel: 150000" or "Banner: 80000-120000".'>
          <textarea id="rc-rates" name="rates" rows={4} className={cx(inputClass, "font-mono")} />
        </Field>
        <Field label="Currency" htmlFor="rc-cur">
          <select id="rc-cur" name="currency" className={inputClass} defaultValue="NGN">
            <option>NGN</option>
            <option>USD</option>
            <option>ZAR</option>
          </select>
        </Field>
      </div>
      <Field label="Rate card file" htmlFor="rc-file" optional hint="PDF, JPEG, PNG or WebP, under 3 MB.">
        <input id="rc-file" name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="block w-full text-sm" />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Submit pending={pending} variant="dark">
          {pending ? "Adding…" : "Add creator"}
        </Submit>
        <Status state={state} />
      </div>
    </form>
  );
}
