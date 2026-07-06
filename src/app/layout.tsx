import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
      </body>
    </html>
  );
}
