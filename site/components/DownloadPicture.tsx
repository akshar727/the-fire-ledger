"use client";

import { useState } from "react";
import { ImageIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { saveBlob, svgToPng } from "@/lib/picture-dom";

export type Picture = { svg: string; width: number; height: number };

export function DownloadPicture({ make, name, what }: { make: () => Picture | null; name: string; what: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (format: "png" | "svg") => {
    setError("");
    setBusy(true);
    try {
      const pic = make();
      if (!pic) return setError("Nothing to draw yet.");
      const blob =
        format === "svg"
          ? new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${pic.svg}`], { type: "image/svg+xml;charset=utf-8" })
          : await svgToPng(pic.svg, pic.width, pic.height, 2);
      saveBlob(blob, `${name}.${format}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The picture could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label={`Download the ${what} as a picture`}>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <ImageIcon aria-hidden className="size-4" />
        Download picture
      </span>
      {(["png", "svg"] as const).map((f) => (
        <Button
          key={f}
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => run(f)}
          aria-label={`Download the ${what} as ${f.toUpperCase()}`}
        >
          {f.toUpperCase()}
        </Button>
      ))}
      <span className="text-destructive" aria-live="polite">
        {error}
      </span>
    </div>
  );
}
