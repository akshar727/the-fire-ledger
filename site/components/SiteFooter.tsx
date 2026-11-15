import Link from "next/link";
import { FirmsAcknowledgment } from "@/components/FirmsAcknowledgment";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 font-mono text-xs leading-relaxed text-muted-foreground sm:px-6 md:grid-cols-[2fr_1fr]">
        <FirmsAcknowledgment className="max-w-[75ch] leading-relaxed" />
        <div className="flex flex-col gap-2 md:items-end md:text-right">
          <p>NASA Space Apps Challenge 2026</p>
          <p>
            See{" "}
            <Link className="underline decoration-primary underline-offset-2 hover:text-foreground" href="/method#sources">
              sources
            </Link>
            .
          </p>
        </div>
      </div>
    </footer>
  );
}
