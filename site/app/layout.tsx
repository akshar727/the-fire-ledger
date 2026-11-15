import type { Metadata } from "next";
import { IBM_Plex_Mono, Work_Sans } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { dayLabel } from "@/lib/annual";
import { recordSpan } from "@/lib/data";
import "./globals.css";

// Red "Thermal console" theme (Ideas_2026-11-15.md §4, scheme A): Work Sans for text, IBM Plex Mono for every
// number, label and control.
const workSans = Work_Sans({
  variable: "--font-work-sans",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const span = recordSpan();

export const metadata: Metadata = {
  title: { default: "One Fire Record", template: "%s | One Fire Record" },
  description: `MODIS and VIIRS active-fire detections from NASA FIRMS, harmonized into one record for ${span.regions}, ${span.first} to ${dayLabel(span.through)}.`,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${workSans.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <TooltipProvider delayDuration={150}>
          <SiteHeader />
          {children}
          <SiteFooter />
        </TooltipProvider>
      </body>
    </html>
  );
}
