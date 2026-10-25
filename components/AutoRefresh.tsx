"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Reloads the page's data every few seconds while files are still being masked.
export default function AutoRefresh({ seconds = 4 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
