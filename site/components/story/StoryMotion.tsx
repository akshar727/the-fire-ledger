"use client";

// The only JavaScript on the landing story: reveals each chapter as it scrolls into view and counts the big numbers
// up. It renders nothing. Without JavaScript, or under prefers-reduced-motion, it never runs and every chapter shows
// its final, static state (the CSS hides nothing unless `data-motion` is set here).
import { useEffect } from "react";

const COUNT_MS = 1400;

function countUp(el: HTMLElement) {
  const end = Number(el.dataset.count);
  if (!Number.isFinite(end)) return;
  const t0 = performance.now();
  const tick = (now: number) => {
    const k = Math.min(1, (now - t0) / COUNT_MS), eased = 1 - (1 - k) ** 3;
    el.textContent = Math.round(end * eased).toLocaleString("en-US");
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function StoryMotion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-story]");
    if (!root || matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const chapters = [...root.querySelectorAll<HTMLElement>("[data-chapter]")];
    const show = (el: HTMLElement) => {
      el.setAttribute("data-in", "");
      el.querySelectorAll<HTMLElement>("[data-count]").forEach(countUp);
    };
    // chapters already on screen stay visible (no flash); only the ones below the fold wait for the scroll
    const onScreen = (el: HTMLElement) => el.getBoundingClientRect().top < window.innerHeight * 0.8;
    chapters.filter(onScreen).forEach((el) => el.setAttribute("data-in", ""));
    root.setAttribute("data-motion", "");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          show(e.target as HTMLElement);
          io.unobserve(e.target);
        }
      },
      // threshold 0 + a margin, not a ratio: a chapter taller than the viewport (400% zoom, landscape phone) could
      // never reach a ratio and would stay hidden
      { threshold: 0, rootMargin: "0px 0px -15% 0px" },
    );
    chapters.filter((el) => !el.hasAttribute("data-in")).forEach((el) => io.observe(el));
    // a keyboard user tabbing into a chapter must never land in a hidden one
    const onFocus = (e: FocusEvent) => {
      const ch = (e.target as HTMLElement).closest<HTMLElement>("[data-chapter]");
      if (ch && !ch.hasAttribute("data-in")) show(ch);
    };
    root.addEventListener("focusin", onFocus);
    return () => {
      io.disconnect();
      root.removeEventListener("focusin", onFocus);
    };
  }, []);
  return null;
}
