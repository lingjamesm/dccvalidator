"use client";

import { useState } from "react";
import { CHANNELS, SCHEMES } from "@/lib/labels";
import { createClient } from "@/lib/supabase/client";

const ACCEPTED = ["image/png", "image/jpeg", "application/pdf"];
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 20;

type Defaults = { entryId?: string; title?: string; channel?: string; schemes?: string[] };

export default function NewSubmissionForm({ defaults }: { defaults: Defaults }) {
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState<string>();

  async function submit(form: HTMLFormElement) {
    setError(undefined);
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    const channel = String(data.get("channel") ?? "");
    const schemes = data.getAll("schemes").map(String);
    const files = data.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

    if (!title) return setError("Give the submission a name.");
    if (!schemes.length) return setError("Choose at least one card scheme.");
    if (!files.length) return setError("Add at least one screen or receipt.");
    if (files.length > MAX_FILES) return setError(`Upload at most ${MAX_FILES} files at a time.`);
    const bad = files.find((f) => !ACCEPTED.includes(f.type) || f.size > MAX_BYTES);
    if (bad) return setError(`${bad.name}: only PNG, JPG or PDF files up to 20 MB.`);

    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return setError("Your session has ended. Please sign in again.");

    setProgress("Creating submission…");
    const { data: submission, error: insertError } = await supabase
      .from("submissions")
      .insert({ title, channel, schemes, ...(defaults.entryId ? { entry_id: defaults.entryId } : {}) })
      .select("id")
      .single();
    if (insertError || !submission) {
      setProgress(undefined);
      return setError(insertError?.message ?? "Could not create the submission.");
    }

    for (const [i, file] of files.entries()) {
      setProgress(`Uploading ${i + 1} of ${files.length}: ${file.name}`);
      const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(-100);
      const path = `${user.id}/${submission.id}/${crypto.randomUUID()}-${safeName}`;
      const { error: uploadError } = await supabase.storage
        .from("submissions")
        .upload(path, file, { contentType: file.type, upsert: false });
      const { error: rowError } = uploadError
        ? { error: uploadError }
        : await supabase.from("submission_files").insert({
            submission_id: submission.id,
            storage_path: path,
            original_name: file.name,
            mime_type: file.type,
            size_bytes: file.size,
          });
      if (rowError) {
        setProgress(undefined);
        return setError(`${file.name} could not be uploaded: ${rowError.message}`);
      }
    }

    await supabase.from("submissions").update({ status: "uploaded" }).eq("id", submission.id);
    window.location.assign(`/workspace/${submission.id}`);
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(e.currentTarget);
      }}
    >
      <label>
        Name
        <input name="title" type="text" defaultValue={defaults.title} placeholder="e.g. Countertop terminal, Nov 2026" required maxLength={200} />
      </label>
      <label>
        Channel
        <select name="channel" defaultValue={defaults.channel ?? "pos"}>
          {Object.entries(CHANNELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 500, marginBottom: 6 }}>Check against</legend>
        <div className="row">
          {Object.entries(SCHEMES).map(([value, label]) => (
            <label key={value} className="inline">
              <input type="checkbox" name="schemes" value={value} defaultChecked={defaults.schemes?.includes(value) ?? true} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Screens and receipts (PNG, JPG or PDF, up to 20 MB each)
        <input name="files" type="file" multiple accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf" required />
      </label>
      <p className="notice">
        Please use test cards only. Automatic card number masking is being added next; until then, do
        not upload real card numbers.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {progress && <p className="muted">{progress}</p>}
      <button type="submit" disabled={!!progress}>
        Submit for DCC validation
      </button>
    </form>
  );
}
