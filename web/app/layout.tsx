import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FashionRepsSwiper",
  description: "Tinder-style swiper for r/FashionReps trusted seller items — live on Vercel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
