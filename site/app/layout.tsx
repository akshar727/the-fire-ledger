import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { dayLabel } from "@/lib/annual";
import { recordSpan } from "@/lib/data";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const span = recordSpan();

export const metadata: Metadata = {
  title: { default: "One Fire Record", template: "%s | One Fire Record" },
  description: `MODIS and VIIRS active-fire detections from NASA FIRMS, harmonized into one record for ${span.regions}, ${span.first} to ${dayLabel(span.through)}.`,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
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
