import Link from "next/link";

// FIRMS acknowledgment: exact text from https://www.earthdata.nasa.gov/data/tools/firms (checked 2026-11-14).
export function SiteFooter() {
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 text-sm text-muted-foreground sm:px-6 md:grid-cols-[2fr_1fr]">
        <p className="max-w-[75ch] leading-relaxed">
          We acknowledge the use of data and/or imagery from NASA&apos;s Fire Information for Resource Management System
          (FIRMS) (
          <a className="underline underline-offset-2 hover:text-foreground" href="https://earthdata.nasa.gov/firms">
            https://earthdata.nasa.gov/firms
          </a>
          ), part of NASA&apos;s Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (
          <a className="underline underline-offset-2 hover:text-foreground" href="https://earthdata.nasa.gov/lance">
            https://earthdata.nasa.gov/lance
          </a>
          ) and NASA&apos;s Earth Science Data and Information System (ESDIS).
        </p>
        <div className="flex flex-col gap-2 md:items-end md:text-right">
          <p>NASA Space Apps Challenge 2026</p>
          <p>
            Built with help from AI (Claude). See{" "}
            <Link className="underline underline-offset-2 hover:text-foreground" href="/method#sources">
              sources
            </Link>
            .
          </p>
        </div>
      </div>
    </footer>
  );
}
