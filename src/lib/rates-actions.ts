"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { isAdmin } from "@/lib/me";
import { MAX_FILE_BYTES, addCreator, cleanCreator, deleteCreator, parseRateLines, setCreatorHidden } from "@/lib/rates";
import type { Result } from "@/lib/actions";

async function requireAdmin() {
  if (!(await isAdmin())) throw new Error("Admins only.");
  return getDb();
}

const refresh = () => revalidatePath("/adminx", "layout");

/** Admin: add a creator from a link, with rates typed in and/or a rate card uploaded. */
export async function adminAddCreatorAction(_: Result | null, form: FormData): Promise<Result> {
  try {
    const db = await requireAdmin();
    const { items, bad } = parseRateLines(String(form.get("rates") ?? ""), String(form.get("currency") ?? "NGN"));
    if (bad.length) return { ok: false, error: `These lines don't read as a rate (use "Reel: 150000"): ${bad.slice(0, 3).join(" · ")}` };
    const upload = form.get("file");
    let file: unknown = null;
    if (upload instanceof File && upload.size > 0) {
      if (upload.size > MAX_FILE_BYTES) return { ok: false, error: "That file is too large. Keep rate cards under 3 MB." };
      file = { name: upload.name, type: upload.type, data: Buffer.from(await upload.arrayBuffer()).toString("base64") };
    }
    const input = cleanCreator({
      link: String(form.get("link") ?? "").trim() || undefined,
      name: String(form.get("name") ?? ""),
      niche: String(form.get("niche") ?? ""),
      type: String(form.get("type") ?? ""),
      country: String(form.get("country") ?? ""),
      followers: String(form.get("followers") ?? "") || undefined,
      items,
      file,
    });
    if ("error" in input) return { ok: false, error: input.error };
    const { creator, created } = await addCreator(db, input, { userId: null, admin: true });
    refresh();
    return { ok: true, message: `${created ? "Added" : "Updated"} ${creator.name}${creator.items.length || creator.files.length ? ` with ${creator.items.length} rate${creator.items.length === 1 ? "" : "s"}${creator.files.length ? ` and ${creator.files.length} file${creator.files.length === 1 ? "" : "s"}` : ""}` : ""}.` };
  } catch (err) {
    console.error(err);
    return { ok: false, error: err instanceof Error && err.message === "Admins only." ? err.message : "Something went wrong. Try again." };
  }
}

export async function hideCreatorAction(form: FormData) {
  const db = await requireAdmin();
  await setCreatorHidden(db, String(form.get("id") ?? ""), form.get("hidden") === "1");
  refresh();
}

export async function deleteCreatorAction(form: FormData) {
  const db = await requireAdmin();
  await deleteCreator(db, String(form.get("id") ?? ""));
  refresh();
}
