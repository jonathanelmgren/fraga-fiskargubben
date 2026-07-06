import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Fråga Fiskargubben",
  description:
    "Fiskeråd med koll på vädret. Fråga gubben innan du kastar, han kollar väder, vattentemp och vilka arter som rör sig.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="sv"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased isolate`}
    >
      <body className="flex min-h-dvh flex-col">
        <SiteHeader />
        {children}
        {/* Plausible (self-hosted). Production only — the script also ignores
            localhost by itself, so local prod builds stay silent. The inline
            stub queues track() calls made before the script loads. */}
        {process.env.NODE_ENV === "production" && (
          <>
            <Script
              defer
              data-domain="fragafiskargubben.se"
              src="https://analytics.mysterylane.se/js/script.js"
            />
            <Script id="plausible-stub">
              {`window.plausible = window.plausible || function() { (window.plausible.q = window.plausible.q || []).push(arguments) }`}
            </Script>
          </>
        )}
      </body>
    </html>
  );
}
