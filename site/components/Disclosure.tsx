"use client";

// FE-025: "details on request". A native <details>/<summary>, so it opens with Enter or Space, works without JavaScript,
// and screen readers announce it as expandable; the content stays in the page (find in page opens it in Chromium).
// `defaultOpen` is read once, on the first render: a later change (e.g. the area box cleared from inside the panel)
// never closes it under the user; after that only the user opens and closes it.
import { useState, type ReactNode } from "react";
import { CaretRightIcon } from "@phosphor-icons/react";

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [initiallyOpen] = useState(defaultOpen);
  return (
    <details className={`group ${className}`} open={initiallyOpen}>
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground transition-colors select-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <CaretRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}
