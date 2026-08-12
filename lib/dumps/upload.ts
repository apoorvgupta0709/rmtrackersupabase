"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { digestOf, type ParsedGrid } from "./parse.ts";

/**
 * Write one parsed sheet into the uploads tables, from the browser.
 *
 * The order matters and is the same one the ingest script uses. The batch is created as
 * `superseded` and only promoted once every row has landed, so a browser that is closed
 * halfway leaves yesterday's dump current rather than promoting an empty one. A refresh
 * reading a dump with no rows would publish a dashboard of zeros — and would look like
 * it had worked.
 */

// PostgREST will take more, but a smaller request survives a phone on a train, and a
// retry costs one chunk rather than the whole workbook.
const CHUNK = 1000;

export type UploadProgress = {
  slot: string;
  sheet: string;
  rowsWritten: number;
  rowsTotal: number;
};

export async function uploadGrid(
  supabase: SupabaseClient,
  grid: ParsedGrid,
  userId: string,
  onProgress?: (progress: UploadProgress) => void,
): Promise<{ batchId: string; digest: string; rows: number }> {
  const digest = await digestOf(grid.rows);

  const { data: batch, error: batchError } = await supabase
    .from("raw_batches")
    .insert({
      slot: grid.slot,
      sheet: grid.sheet,
      original_filename: grid.sourceFile,
      content_sha256: digest,
      columns: [],        // the grid is raw; naming happens at read time
      column_types: {},
      row_count: grid.rows.length,
      status: "superseded",
      uploaded_by: userId,
    })
    .select("id")
    .single();

  if (batchError) throw new Error(`${grid.slot}: ${batchError.message}`);

  for (let start = 0; start < grid.rows.length; start += CHUNK) {
    const slice = grid.rows.slice(start, start + CHUNK);
    const { error } = await supabase.from("raw_rows").insert(
      slice.map((row, i) => ({ batch_id: batch.id, seq: start + i, row })),
    );
    if (error) throw new Error(`${grid.slot} rows ${start}: ${error.message}`);
    onProgress?.({
      slot: grid.slot,
      sheet: grid.sheet,
      rowsWritten: Math.min(start + CHUNK, grid.rows.length),
      rowsTotal: grid.rows.length,
    });
  }

  // Refuses unless every declared row arrived, so a truncated upload never becomes the
  // one the refresh reads.
  const { error: promoteError } = await supabase.rpc("promote_upload", {
    new_batch: batch.id,
  });
  if (promoteError) throw new Error(`${grid.slot}: ${promoteError.message}`);

  return { batchId: batch.id, digest, rows: grid.rows.length };
}

/**
 * Has this exact content been uploaded for this slot before?
 *
 * Content, never size. On 7 August rfd_4731.xlsx arrived at exactly the previous day's
 * 57,435 bytes with a different digest, so a size check would have called a genuinely
 * new extract stale and skipped it. This is a warning and never a block: the owner can
 * see it and decide, because sometimes a dump really is unchanged and worth re-loading.
 */
export async function previouslySeen(
  supabase: SupabaseClient,
  slot: string,
  digest: string,
): Promise<{ seen: boolean; uploadedAt?: string }> {
  const { data } = await supabase
    .from("raw_batches")
    .select("uploaded_at")
    .eq("slot", slot)
    .eq("content_sha256", digest)
    .order("uploaded_at", { ascending: false })
    .limit(1);

  if (!data || data.length === 0) return { seen: false };
  return { seen: true, uploadedAt: data[0].uploaded_at as string };
}
