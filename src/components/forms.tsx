"use client";

import { useEffect, useRef } from "react";
import { addCommentAction, addXPostAction, checkInAction, postMomentAction, saveCardAction, saveUpdateAction } from "@/lib/actions";
import type { Person } from "@/lib/db/schema";
import { MAX_MOMENT_PHOTOS, OFFERS, WANTS } from "@/lib/constants";
import { MultiPhotoPicker, MultiSelect, PhotoPicker, Status, Submit, useForm } from "./client";
import { Field, cx, inputClass } from "./ui";

const contactOf = (p: Person | null) => (p ? (p.xHandle ? `@${p.xHandle}` : p.whatsapp ?? p.email ?? p.linkedinUrl ?? p.websiteUrl ?? "") : "");

export function CardForm({ person, event }: { person: Person | null; event: string }) {
  const { state, pending, onSubmit, err } = useForm(saveCardAction, { refresh: true });
  const p = person;
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <input type="hidden" name="event" value={event} />
      <Field label="Name" htmlFor="name" error={err("name")}>
        <input id="name" name="name" autoComplete="name" defaultValue={p?.name} maxLength={60} className={inputClass} aria-invalid={!!err("name")} />
      </Field>
      <Field label="What you do" htmlFor="headline" error={err("headline")}>
        <input id="headline" name="headline" defaultValue={p?.headline} maxLength={80} placeholder="Founder at a payments startup" className={inputClass} aria-invalid={!!err("headline")} />
      </Field>
      <Field label="Looking to meet" htmlFor="wants">
        <MultiSelect id="wants" name="wants" options={WANTS} initial={p?.wants} max={3} placeholder="Choose up to 3" />
      </Field>
      <Field label="Your X handle" htmlFor="contact" error={err("contact")} hint="That's enough for people to reach you. No X? A WhatsApp number, email or LinkedIn link works too. It shows on your card.">
        <input id="contact" name="contact" defaultValue={contactOf(p)} placeholder="@yourhandle" autoCapitalize="none" autoCorrect="off" className={inputClass} aria-invalid={!!err("contact")} />
      </Field>
      <details className="group" open={Boolean(p?.offers.length || p?.company)}>
        <summary className="cursor-pointer text-sm font-semibold text-muted">More (optional)</summary>
        <div className="mt-4 space-y-5">
          <Field label="I can help with" htmlFor="offers">
            <MultiSelect id="offers" name="offers" options={OFFERS} initial={p?.offers} max={3} placeholder="Choose up to 3" />
          </Field>
          <Field label="Company" htmlFor="company">
            <input id="company" name="company" defaultValue={p?.company ?? ""} maxLength={80} className={inputClass} />
          </Field>
        </div>
      </details>
      <div className="flex items-center gap-3">
        <Submit pending={pending} size="lg" className="shrink-0" data-track={p ? "save_card" : "add_me"}>
          {p ? "Save" : "Add me"}
        </Submit>
        <div className="min-w-0 text-sm">
          <Status state={state} />
        </div>
      </div>
    </form>
  );
}

export function XPostForm({ event }: { event: string }) {
  const { state, pending, onSubmit } = useForm(addXPostAction);
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <input type="hidden" name="event" value={event} />
      <label htmlFor="url" className="block text-sm font-semibold">
        Link to your post about the event
      </label>
      <div className="flex gap-2">
        <input id="url" name="url" inputMode="url" placeholder="x.com/you/status/…" className={inputClass} />
        <Submit pending={pending} variant="dark" data-track="add_x_post">
          Add
        </Submit>
      </div>
      <Status state={state} />
    </form>
  );
}

export function CommentForm({ postId, myName }: { postId: string; myName: string | null }) {
  const { state, pending, onSubmit } = useForm(addCommentAction, { refresh: true });
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.querySelector<HTMLInputElement>("input[name=body]")?.form?.reset();
  }, [state]);
  return (
    <form ref={ref} onSubmit={onSubmit} className="space-y-2">
      <input type="hidden" name="postId" value={postId} />
      {!myName && (
        <>
          <label htmlFor={`cn-${postId}`} className="sr-only">
            Your name
          </label>
          <input id={`cn-${postId}`} name="name" maxLength={40} placeholder="Your name" className={cx(inputClass, "py-2")} />
        </>
      )}
      <div className="flex gap-2">
        <label htmlFor={`cb-${postId}`} className="sr-only">
          Comment
        </label>
        <input id={`cb-${postId}`} name="body" maxLength={280} placeholder={myName ? `Comment as ${myName}` : "Say hi or ask to meet"} className={cx(inputClass, "py-2")} />
        <Submit pending={pending} variant="dark" size="sm" className="h-auto" data-track="comment" data-track-id={postId}>
          Post
        </Submit>
      </div>
      {state && !state.ok && <Status state={state} />}
    </form>
  );
}

export function UpdateForm({ person, event }: { person: Person; event: string }) {
  const { state, pending, onSubmit, err } = useForm(saveUpdateAction);
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      <input type="hidden" name="event" value={event} />
      <PhotoPicker current={person.photoUpdatedAt ? `/photo/${person.id}?v=${person.photoUpdatedAt.getTime()}` : null} error={err("photo")} />
      <p className="text-xs text-muted">A picture of you on your card helps people recognise you at the event.</p>
      <div className="flex items-center gap-3">
        <Submit pending={pending} size="lg" className="shrink-0" data-track="post_update">
          Save photo
        </Submit>
        <div className="min-w-0 text-sm">
          <Status state={state} />
        </div>
      </div>
    </form>
  );
}

export function MomentForm({ myName, event }: { myName: string | null; event: string }) {
  const { state, pending, onSubmit, err } = useForm(postMomentAction);
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <input type="hidden" name="event" value={event} />
      <MultiPhotoPicker max={MAX_MOMENT_PHOTOS} error={err("photo")} />
      <Field label="…or share an X post" htmlFor="xUrl" optional error={err("xUrl")} hint="Paste a link to a public post. Its text and images are shown with a link back to X.">
        <input id="xUrl" name="xUrl" inputMode="url" placeholder="x.com/name/status/…" className={inputClass} />
      </Field>
      <Field label="What's happening?" htmlFor="body" optional error={err("body")}>
        <textarea id="body" name="body" rows={2} maxLength={280} placeholder="My best moment… (tag people with @handle)" className={inputClass} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Where?" htmlFor="place" optional error={err("place")}>
          <input id="place" name="place" maxLength={100} placeholder="Main hall" className={inputClass} />
        </Field>
        {myName ? (
          <p className="self-end pb-3 text-sm text-muted">
            Posting as <span className="font-semibold text-ink">{myName}</span>
          </p>
        ) : (
          <Field label="Your name or @handle" htmlFor="mname" optional>
            <input id="mname" name="name" maxLength={40} placeholder="@yourhandle" autoCapitalize="none" className={inputClass} />
          </Field>
        )}
      </div>
      <div className="flex items-center gap-3">
        <Submit pending={pending} size="lg" className="shrink-0" data-track="post_moment">
          Post
        </Submit>
        <div className="min-w-0 text-sm">
          <Status state={state} />
        </div>
      </div>
    </form>
  );
}


const DURATIONS = [
  ["1", "1 hour"],
  ["2", "2 hours"],
  ["4", "4 hours"],
  ["day", "Rest of today"],
] as const;

export function CheckinForm({ me, event }: { me: { name: string } | null; event: string }) {
  const { state, pending, onSubmit, err } = useForm(checkInAction);
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3">
      <input type="hidden" name="event" value={event} />
      <div className={cx("grid gap-3", me ? "sm:grid-cols-[1fr_auto]" : "sm:grid-cols-[1fr_1fr_auto]")}>
        <div>
          <label htmlFor="place" className="sr-only">
            Where are you?
          </label>
          <input id="place" name="place" maxLength={100} placeholder="Where are you? e.g. Booth 14, Hall B" className={inputClass} aria-invalid={!!err("place")} aria-label="Where are you?" />
          {err("place") && <p className="mt-1 text-xs text-red-600">{err("place")}</p>}
        </div>
        {!me && (
          <div>
            <label htmlFor="ci-contact" className="sr-only">
              Your X handle
            </label>
            <input id="ci-contact" name="contact" placeholder="Your X handle, e.g. @you" autoCapitalize="none" className={inputClass} aria-invalid={!!err("contact")} aria-label="Your X handle" />
            {err("contact") && <p className="mt-1 text-xs text-red-600">{err("contact")}</p>}
          </div>
        )}
        <Submit pending={pending} size="lg" className="shrink-0" data-track="checkin">
          📍 I&apos;m here
        </Submit>
      </div>
      {(err("name") || (state && !state.ok && !err("place") && !err("contact"))) && (
        <p role="alert" className="text-sm text-red-600">
          {err("name") ?? (state && !state.ok ? state.error : "")}
        </p>
      )}
      <details className="text-sm" open={Boolean(err("name"))}>
        <summary className="cursor-pointer text-muted">
          {me ? (
            <>
              Checking in as <span className="font-semibold text-ink">{me.name}</span> · more options
            </>
          ) : (
            "More options (name, what you're up for, how long)"
          )}
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {!me && (
            <Field label="Your name" htmlFor="ci-name" optional hint="Needed if you used a phone number or email above.">
              <input id="ci-name" name="name" maxLength={60} autoComplete="name" className={inputClass} />
            </Field>
          )}
          <Field label="Up for…" htmlFor="note" optional error={err("note")}>
            <input id="note" name="note" maxLength={140} placeholder="Coffee and a chat about fintech" className={inputClass} />
          </Field>
          {!me && (
            <Field label="What you do" htmlFor="ci-headline" optional>
              <input id="ci-headline" name="headline" maxLength={80} placeholder="Founder, payments startup" className={inputClass} />
            </Field>
          )}
          <Field label="For how long?" htmlFor="ci-for">
            <select id="ci-for" name="for" defaultValue="2" className={inputClass}>
              {DURATIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </details>
    </form>
  );
}

